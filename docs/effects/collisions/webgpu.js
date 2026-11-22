// WebGPU Compute primary engine for Evolution of Collision Detection & Tunneling (1988-2024).
// Genuine WGSL compute pipelines:
//   - 2x 4,096-projectile GPU rigid-body / Swept-CCD / Discrete tunneling storage buffers (Left & Right Split!)
//   - 16x8x16 (2,048 cells) GPU 3D Spatial Hash atomic occupancy grid (GPU Gems 3 Ch. 32)
//   - Shared depth32float seamlessly compositing Tactical Lab Floor + Opaque PBR + 4,096 GPU Bullets + Translucent Hulls/Ghosts/Grid!

import {
  DEFAULT_CAMERA, MAX_INSTANCES, GRID_DIMS,
  computeCameraBasis, createPrimitiveMesh, createCollisionsController,
} from "./shared.js";
import {
  GRID_CLEAR_WGSL, BULLET_SIM_WGSL, ENV_FLOOR_WGSL, PRIMITIVE_PBR_WGSL,
} from "./wgsl.js";

const GPU_BULLETS = 4096;
const GRID_CELLS = GRID_DIMS[0] * GRID_DIMS[1] * GRID_DIMS[2]; // 2,048 cells
const UBO_STRIDE = 256;
const UBO_SIZE = 144; // mat4 (64) + 5 vec4f (80)
const UBO_SLOTS = 8;  // per side (0,1) x 4 pass modes (0=opaque, 1=trans, 2=gpuBullets, 3=gpuGridCells)

export async function createCollisionsWebGPU(hostCanvas) {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    throw new Error("WebGPU API unavailable");
  }
  const adapter =
    (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ||
    (await navigator.gpu.requestAdapter());
  if (!adapter) throw new Error("No WebGPU adapter available");
  const device = await adapter.requestDevice();
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  let gpuCanvas = document.getElementById("cGpuCollisions");
  if (!gpuCanvas) {
    gpuCanvas = document.createElement("canvas");
    gpuCanvas.id = "cGpuCollisions";
    gpuCanvas.setAttribute("aria-hidden", "true");
    gpuCanvas.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;display:block;z-index:-3;pointer-events:none;background:#0d1220;";
    if (hostCanvas && hostCanvas.parentNode) hostCanvas.after(gpuCanvas);
    else document.body.appendChild(gpuCanvas);
  }
  const context = gpuCanvas.getContext("webgpu");
  if (!context) {
    gpuCanvas.remove();
    throw new Error("Could not acquire WebGPU canvas context");
  }
  context.configure({
    device,
    format: canvasFormat,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  device.pushErrorScope("validation");

  const pipeGridClear = device.createComputePipeline({
    label: "gridClear",
    layout: "auto",
    compute: { module: device.createShaderModule({ label: "gridClear", code: GRID_CLEAR_WGSL }), entryPoint: "main" },
  });
  const pipeBulletSim = device.createComputePipeline({
    label: "bulletSim",
    layout: "auto",
    compute: { module: device.createShaderModule({ label: "bulletSim", code: BULLET_SIM_WGSL }), entryPoint: "main" },
  });

  const envMod = device.createShaderModule({ label: "envFloor", code: ENV_FLOOR_WGSL });
  const pipeEnv = device.createRenderPipeline({
    label: "envFloor",
    layout: "auto",
    vertex: { module: envMod, entryPoint: "vsMain" },
    fragment: { module: envMod, entryPoint: "fsMain", targets: [{ format: canvasFormat }] },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });

  const primMod = device.createShaderModule({ label: "primPbr", code: PRIMITIVE_PBR_WGSL });
  const primVertBuffers = [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
    { arrayStride: 8,  attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },
  ];
  const pipeOpaque = device.createRenderPipeline({
    label: "primOpaque",
    layout: "auto",
    vertex: { module: primMod, entryPoint: "vsMain", buffers: primVertBuffers },
    fragment: { module: primMod, entryPoint: "fsMain", targets: [{ format: canvasFormat }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
  });
  const pipeTrans = device.createRenderPipeline({
    label: "primTrans",
    layout: "auto",
    vertex: { module: primMod, entryPoint: "vsMain", buffers: primVertBuffers },
    fragment: {
      module: primMod,
      entryPoint: "fsMain",
      targets: [{
        format: canvasFormat,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "less" },
  });

  const mesh = createPrimitiveMesh();
  const mkBuf = (data, usage) => {
    const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const vbPos = mkBuf(mesh.positions, GPUBufferUsage.VERTEX);
  const vbNrm = mkBuf(mesh.normals, GPUBufferUsage.VERTEX);
  const vbUv  = mkBuf(mesh.uvs, GPUBufferUsage.VERTEX);
  const ibIdx = mkBuf(mesh.indices, GPUBufferUsage.INDEX);
  const indexCount = mesh.indices.length;

  const frameUbo = device.createBuffer({ size: UBO_STRIDE * UBO_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const frameData = new Float32Array((UBO_STRIDE * UBO_SLOTS) / 4);
  const simUbo = device.createBuffer({ size: 256 * 2, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const simUboData = new Float32Array(128);

  const instBufs = [0, 1].map(() => device.createBuffer({ size: MAX_INSTANCES * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const instScratch = [new Float32Array(MAX_INSTANCES * 16), new Float32Array(MAX_INSTANCES * 16)];
  const bulletBufs = [0, 1].map(() => device.createBuffer({ size: GPU_BULLETS * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const gridBufs = [0, 1].map(() => device.createBuffer({ size: GRID_CELLS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));

  const bgGridClear = [0, 1].map(s => device.createBindGroup({
    layout: pipeGridClear.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: gridBufs[s] } }],
  }));
  const bgBulletSim = [0, 1].map(s => device.createBindGroup({
    layout: pipeBulletSim.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: simUbo, offset: s * 256, size: 32 } },
      { binding: 1, resource: { buffer: bulletBufs[s] } },
      { binding: 2, resource: { buffer: gridBufs[s] } },
    ],
  }));

  const bgEnv = [0, 1].map(s => device.createBindGroup({
    layout: pipeEnv.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: frameUbo, offset: (s * 4) * UBO_STRIDE, size: UBO_SIZE } }],
  }));

  const bgOpaqueInst = [0, 1].map(s => device.createBindGroup({
    layout: pipeOpaque.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: (s * 4 + 0) * UBO_STRIDE, size: UBO_SIZE } },
      { binding: 1, resource: { buffer: instBufs[s] } },
      { binding: 2, resource: { buffer: gridBufs[s] } },
    ],
  }));
  const bgOpaqueBullets = [0, 1].map(s => device.createBindGroup({
    layout: pipeOpaque.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: (s * 4 + 2) * UBO_STRIDE, size: UBO_SIZE } },
      { binding: 1, resource: { buffer: bulletBufs[s] } },
      { binding: 2, resource: { buffer: gridBufs[s] } },
    ],
  }));
  const bgTransInst = [0, 1].map(s => device.createBindGroup({
    layout: pipeTrans.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: (s * 4 + 1) * UBO_STRIDE, size: UBO_SIZE } },
      { binding: 1, resource: { buffer: instBufs[s] } },
      { binding: 2, resource: { buffer: gridBufs[s] } },
    ],
  }));
  const bgTransGrid = [0, 1].map(s => device.createBindGroup({
    layout: pipeTrans.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: (s * 4 + 3) * UBO_STRIDE, size: UBO_SIZE } },
      { binding: 1, resource: { buffer: instBufs[s] } },
      { binding: 2, resource: { buffer: gridBufs[s] } },
    ],
  }));

  const valErr = await device.popErrorScope();
  if (valErr) {
    gpuCanvas.remove();
    throw new Error("WebGPU shader validation failed: " + valErr.message);
  }

  let depthTex = null, depthView = null, curW = 0, curH = 0;
  function ensureDepth(w, h) {
    if (curW === w && curH === h && depthTex) return;
    if (depthTex) depthTex.destroy();
    curW = w; curH = h;
    depthTex = device.createTexture({ size: [w, h], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    depthView = depthTex.createView();
  }

  const ctrl = createCollisionsController("webgpu");
  let lastDt = 0.016, simTime = 0, pausedNow = false;

  function writeFrameSlotsForSide(side, basis, sim) {
    for (let mode = 0; mode < 4; mode++) {
      const off = ((side * 4 + mode) * UBO_STRIDE) / 4;
      frameData.set(basis.viewProjGPU, off);
      let p = off + 16;
      frameData[p++] = basis.eye[0];   frameData[p++] = basis.eye[1];   frameData[p++] = basis.eye[2];   frameData[p++] = basis.tanHalf;
      frameData[p++] = basis.fwd[0];   frameData[p++] = basis.fwd[1];   frameData[p++] = basis.fwd[2];   frameData[p++] = basis.aspect;
      frameData[p++] = basis.right[0]; frameData[p++] = basis.right[1]; frameData[p++] = basis.right[2]; frameData[p++] = simTime;
      frameData[p++] = basis.up[0];    frameData[p++] = basis.up[1];    frameData[p++] = basis.up[2];    frameData[p++] = sim.stage;
      if (mode === 0) {
        // Note: ENV_FLOOR reads extra.xy as wallFlashGood / wallFlashBad while PRIMITIVE_PBR reads extra.x as passMode (0=opaque)!
        // Wait: keep mode 0 = 0.0 so PRIMITIVE_PBR sees mode 0 cleanly! ENV_FLOOR reads flash from camUp/extra cleanly below.
        frameData[p++] = 0.0; frameData[p++] = sim.wallFlashBad; frameData[p++] = 1.0; frameData[p++] = sim.wallFlashGood;
      } else {
        frameData[p++] = mode; frameData[p++] = sim.wallFlashBad; frameData[p++] = 1.0; frameData[p++] = sim.wallFlashGood;
      }
    }
  }

  return {
    id: "collisions",
    backend: "webgpu",
    usesExternalCanvas: true,
    gpuCanvas,
    maxPixels: 960000,
    defaultCamera: DEFAULT_CAMERA,

    setVisible(v) { gpuCanvas.style.display = v ? "block" : "none"; },
    enterStep(idx) { ctrl.enterStep(idx); },
    onReset() { ctrl.onReset(); },
    triggerAction(id) { ctrl.triggerAction(id); },
    isActionActive(id) { return ctrl.isActionActive(id); },
    onCanvasClick(x, y) { ctrl.onCanvasClick(x, y); },
    getTechBadge(idx) { return ctrl.getTechBadge(idx); },
    resize(w, h) {
      if (gpuCanvas.width !== w || gpuCanvas.height !== h) { gpuCanvas.width = w; gpuCanvas.height = h; }
      ensureDepth(w, h);
    },
    update(dt, paused) {
      pausedNow = paused;
      lastDt = paused ? 0 : Math.min(dt, 0.033);
      if (!paused) simTime += lastDt;
      ctrl.update(dt, paused);
    },
    render(w, h, step, split, cam) {
      if (gpuCanvas.width !== w || gpuCanvas.height !== h) { gpuCanvas.width = w; gpuCanvas.height = h; }
      ensureDepth(w, h);

      const stageR = split.enabled ? (step.compareRight ?? step.stage ?? 7) : (step.stage ?? 0);
      const stageL = split.enabled ? (step.compareLeft ?? 0) : stageR;
      ctrl.setActiveStages(stageL, stageR);

      const basis = computeCameraBasis(cam, w / Math.max(1, h));
      const activeSides = split.enabled ? [[0, ctrl.getSim(stageL)], [1, ctrl.getSim(stageR)]] : [[1, ctrl.getSim(stageR)]];
      const instCounts = [0, 0];

      for (const [side, sObj] of activeSides) {
        const sim = sObj.sim;
        instCounts[side] = sObj.packInstances(instScratch[side], MAX_INSTANCES);
        if (instCounts[side] > 0) {
          device.queue.writeBuffer(instBufs[side], 0, instScratch[side], 0, instCounts[side] * 16);
        }
        writeFrameSlotsForSide(side, basis, sim);

        const so = side * 64;
        const wHalf = (sim.stage === 6 && !sim.thinWall) ? 0.34 : 0.08;
        const simDt = (sim.stage === 0 && sim.lowTickRate) ? (lastDt * 1.45) : lastDt;
        simUboData[so + 0] = pausedNow ? 0 : simDt;
        simUboData[so + 1] = simTime;
        simUboData[so + 2] = sim.stage;
        simUboData[so + 3] = sim.resetGpuPending ? 1.0 : 0.0;
        simUboData[so + 4] = wHalf;
        simUboData[so + 5] = sim.shockwavePending ? 1.0 : 0.0;
        simUboData[so + 6] = sim.lowTickRate ? 1.0 : 0.0;
        simUboData[so + 7] = 0.0;
        sim.resetGpuPending = false;
        sim.shockwavePending = false;
      }

      device.queue.writeBuffer(frameUbo, 0, frameData);
      device.queue.writeBuffer(simUbo, 0, simUboData);

      const enc = device.createCommandEncoder();

      // 1) GPU Compute Passes: Clear 3D Spatial Hash Grid + Simulate 4,096 GPU Bullets / Spatial Orbs!
      {
        const cp = enc.beginComputePass();
        for (const [side, sObj] of activeSides) {
          if (sObj.sim.stage === 4) {
            cp.setPipeline(pipeGridClear);
            cp.setBindGroup(0, bgGridClear[side]);
            cp.dispatchWorkgroups(GRID_CELLS / 64, 1, 1);
          }
          cp.setPipeline(pipeBulletSim);
          cp.setBindGroup(0, bgBulletSim[side]);
          cp.dispatchWorkgroups(GPU_BULLETS / 64, 1, 1);
        }
        cp.end();
      }

      // 2) Render Pass (Scissor-Split for Dual-Era Live Comparison!)
      const swapView = context.getCurrentTexture().createView();
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: swapView,
          clearValue: { r: 0.04, g: 0.06, b: 0.11, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });

      const splitX = Math.max(1, Math.min(w - 1, Math.round(split.pos * w)));
      const drawSide = (side, sObj, sx, sw) => {
        if (sw <= 0) return;
        rp.setScissorRect(sx, 0, sw, h);

        // Pass A: Tactical calibration floor + studio backdrop (writes depth)
        rp.setPipeline(pipeEnv);
        rp.setBindGroup(0, bgEnv[side]);
        rp.draw(3, 1, 0, 0);

        // Pass B1: Opaque PBR walls, turrets, rods, SAP spheres & 4,096 GPU Compute Bullets
        rp.setPipeline(pipeOpaque);
        rp.setVertexBuffer(0, vbPos);
        rp.setVertexBuffer(1, vbNrm);
        rp.setVertexBuffer(2, vbUv);
        rp.setIndexBuffer(ibIdx, "uint16");

        if (instCounts[side] > 0) {
          rp.setBindGroup(0, bgOpaqueInst[side]);
          rp.drawIndexed(indexCount, instCounts[side], 0, 0, 0);
        }
        const stg = sObj.sim.stage;
        if (stg === 0 || stg === 4 || stg === 6 || stg === 7) {
          rp.setBindGroup(0, bgOpaqueBullets[side]);
          rp.drawIndexed(indexCount, GPU_BULLETS, 0, 0, 0);
        }

        // Pass B2: Translucent Ghost Tick Spheres, Minkowski Hull, SAT Plane, Impact Rings & 3D GPU Spatial Grid Cells!
        rp.setPipeline(pipeTrans);
        rp.setVertexBuffer(0, vbPos);
        rp.setVertexBuffer(1, vbNrm);
        rp.setVertexBuffer(2, vbUv);
        rp.setIndexBuffer(ibIdx, "uint16");

        if (instCounts[side] > 0) {
          rp.setBindGroup(0, bgTransInst[side]);
          rp.drawIndexed(indexCount, instCounts[side], 0, 0, 0);
        }
        if (stg === 4) {
          rp.setBindGroup(0, bgTransGrid[side]);
          rp.drawIndexed(indexCount, GRID_CELLS, 0, 0, 0);
        }
      };

      if (split.enabled) {
        drawSide(0, ctrl.getSim(stageL), 0, splitX);
        drawSide(1, ctrl.getSim(stageR), splitX, w - splitX);
      } else {
        drawSide(1, ctrl.getSim(stageR), 0, w);
      }

      rp.end();
      device.queue.submit([enc.finish()]);
    },
  };
}
