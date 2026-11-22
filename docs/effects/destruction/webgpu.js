// WebGPU Compute primary engine for Evolution of Destruction & Fracturing (1998-2023).
// Genuine WGSL compute pipelines:
//   - 2x 8,192-particle GPU rigid-body debris storage buffers (independent Left & Right Split simulations!)
//   - 48x72x48 (165,888 voxels) 3D storage buffer with GPU compute blast carving + exact 3D DDA raymarching
//   - Shared 32-bit hardware depth buffer seamlessly compositing Raymarched CSG/Voxels + Hardware-Instanced PBR Blocks + 8,192 GPU Debris + Alpha Dust Plumes!

import {
  DEFAULT_CAMERA, TOWER_BOUNDS, MAX_INSTANCES, MAX_CRATERS, MAX_DUST,
  computeCameraBasis, createAdaptiveBlockMesh, createDestructionController,
} from "./shared.js";
import {
  DEBRIS_EMIT_WGSL, DEBRIS_SIM_WGSL, VOXEL_CARVE_WGSL,
  ENV_RAYMARCH_WGSL, BLOCK_PBR_WGSL, DUST_PLUME_WGSL,
} from "./wgsl.js";

const VOX_DIMS = [48, 72, 48];
const VOX_COUNT = VOX_DIMS[0] * VOX_DIMS[1] * VOX_DIMS[2]; // 165,888 voxels
const GPU_DEBRIS_COUNT = 8192;

const FRAME_UBO_SIZE = 464;    // 116 floats
const FRAME_UBO_STRIDE = 512;  // 256-byte minUniformBufferOffsetAlignment x 2
const FRAME_UBO_SLOTS = 4;     // 0=Left Main, 1=Left Debris, 2=Right Main, 3=Right Debris

export async function createDestructionWebGPU(hostCanvas) {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    throw new Error("WebGPU API unavailable");
  }
  const adapter =
    (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ||
    (await navigator.gpu.requestAdapter());
  if (!adapter) {
    throw new Error("No WebGPU adapter available");
  }
  const device = await adapter.requestDevice();
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  // Dedicated sibling WebGPU canvas behind #c (keeps #c opacity:0 for pointer/wheel input without colliding with GI's #cGpu)
  let gpuCanvas = document.getElementById("cGpuDestruction");
  if (!gpuCanvas) {
    gpuCanvas = document.createElement("canvas");
    gpuCanvas.id = "cGpuDestruction";
    gpuCanvas.setAttribute("aria-hidden", "true");
    gpuCanvas.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;display:block;z-index:-3;pointer-events:none;background:#151423;";
    if (hostCanvas && hostCanvas.parentNode) {
      hostCanvas.after(gpuCanvas);
    } else {
      document.body.appendChild(gpuCanvas);
    }
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

  // 1) Compute Pipelines
  const pipeDebrisEmit = device.createComputePipeline({
    label: "debrisEmit",
    layout: "auto",
    compute: { module: device.createShaderModule({ label: "debrisEmit", code: DEBRIS_EMIT_WGSL }), entryPoint: "main" },
  });
  const pipeDebrisSim = device.createComputePipeline({
    label: "debrisSim",
    layout: "auto",
    compute: { module: device.createShaderModule({ label: "debrisSim", code: DEBRIS_SIM_WGSL }), entryPoint: "main" },
  });
  const pipeVoxelCarve = device.createComputePipeline({
    label: "voxelCarve",
    layout: "auto",
    compute: { module: device.createShaderModule({ label: "voxelCarve", code: VOXEL_CARVE_WGSL }), entryPoint: "main" },
  });

  // 2) Render Pipelines sharing depth32float
  const envMod = device.createShaderModule({ label: "envRaymarch", code: ENV_RAYMARCH_WGSL });
  const pipeEnv = device.createRenderPipeline({
    label: "envRaymarch",
    layout: "auto",
    vertex: { module: envMod, entryPoint: "vsMain" },
    fragment: { module: envMod, entryPoint: "fsMain", targets: [{ format: canvasFormat }] },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });

  const blockMod = device.createShaderModule({ label: "blockPbr", code: BLOCK_PBR_WGSL });
  const pipeBlock = device.createRenderPipeline({
    label: "blockPbr",
    layout: "auto",
    vertex: {
      module: blockMod,
      entryPoint: "vsMain",
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
        { arrayStride: 8,  attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },
      ],
    },
    fragment: { module: blockMod, entryPoint: "fsMain", targets: [{ format: canvasFormat }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
  });

  const dustMod = device.createShaderModule({ label: "dustPlume", code: DUST_PLUME_WGSL });
  const pipeDust = device.createRenderPipeline({
    label: "dustPlume",
    layout: "auto",
    vertex: { module: dustMod, entryPoint: "vsMain" },
    fragment: {
      module: dustMod,
      entryPoint: "fsMain",
      targets: [{
        format: canvasFormat,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "less" },
  });

  // 3) Static Mesh Buffers (Adaptive Subdivided Block)
  const mesh = createAdaptiveBlockMesh();
  function mkBuf(data, usage) {
    const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  }
  const vbPos = mkBuf(mesh.positions, GPUBufferUsage.VERTEX);
  const vbNrm = mkBuf(mesh.normals, GPUBufferUsage.VERTEX);
  const vbUv  = mkBuf(mesh.uvs, GPUBufferUsage.VERTEX);
  const ibIdx = mkBuf(mesh.indices, GPUBufferUsage.INDEX);
  const indexCount = mesh.indices.length;

  // 4) Uniform & Storage Buffers (independent slots for Left & Right Split-Screen halves!)
  const frameUbo = device.createBuffer({
    size: FRAME_UBO_STRIDE * FRAME_UBO_SLOTS,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const frameData = new Float32Array((FRAME_UBO_STRIDE * FRAME_UBO_SLOTS) / 4);

  const instBufs = [0, 1].map(() => device.createBuffer({
    size: MAX_INSTANCES * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));
  const instScratch = [new Float32Array(MAX_INSTANCES * 16), new Float32Array(MAX_INSTANCES * 16)];

  const dustBufs = [0, 1].map(() => device.createBuffer({
    size: MAX_DUST * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));
  const dustScratch = [new Float32Array(MAX_DUST * 8), new Float32Array(MAX_DUST * 8)];

  // Two independent 8,192-particle GPU debris compute buffers (Left & Right)
  const debrisBufs = [0, 1].map(() => device.createBuffer({
    size: GPU_DEBRIS_COUNT * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));
  const debrisCursors = [0, 0];
  let emitSeed = 1.0;

  // Up to 8 queued emit/carve uniform slots per frame so multiple hits never clobber before submit
  const EMIT_SLOTS = 8;
  const emitUbo = device.createBuffer({ size: 256 * EMIT_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const simUbo = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const carveUbo = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // 48x72x48 3D Voxel Storage Buffer (165,888 u32s = 663 KB)
  const voxelBuf = device.createBuffer({
    size: VOX_COUNT * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const voxelUpload = new Uint32Array(VOX_COUNT);

  // 5) Bind Groups
  const bgEnv = [0, 1].map(side => device.createBindGroup({
    layout: pipeEnv.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: side * 2 * FRAME_UBO_STRIDE, size: FRAME_UBO_SIZE } },
      { binding: 1, resource: { buffer: voxelBuf } },
    ],
  }));

  const bgBlocks = [0, 1].map(side => device.createBindGroup({
    layout: pipeBlock.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: side * 2 * FRAME_UBO_STRIDE, size: FRAME_UBO_SIZE } },
      { binding: 1, resource: { buffer: instBufs[side] } },
    ],
  }));

  const bgDebrisRender = [0, 1].map(side => device.createBindGroup({
    layout: pipeBlock.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: (side * 2 + 1) * FRAME_UBO_STRIDE, size: FRAME_UBO_SIZE } },
      { binding: 1, resource: { buffer: debrisBufs[side] } },
    ],
  }));

  const bgDust = [0, 1].map(side => device.createBindGroup({
    layout: pipeDust.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUbo, offset: side * 2 * FRAME_UBO_STRIDE, size: FRAME_UBO_SIZE } },
      { binding: 1, resource: { buffer: dustBufs[side] } },
    ],
  }));

  const bgDebrisSim = [0, 1].map(side => device.createBindGroup({
    layout: pipeDebrisSim.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: simUbo, offset: 0, size: 16 } },
      { binding: 1, resource: { buffer: debrisBufs[side] } },
    ],
  }));

  const bgDebrisEmit = [0, 1].map(side =>
    Array.from({ length: EMIT_SLOTS }, (_, k) => device.createBindGroup({
      layout: pipeDebrisEmit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: emitUbo, offset: k * 256, size: 48 } },
        { binding: 1, resource: { buffer: debrisBufs[side] } },
      ],
    }))
  );

  const bgVoxelCarve = Array.from({ length: 4 }, (_, k) => device.createBindGroup({
    layout: pipeVoxelCarve.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: carveUbo, offset: k * 256, size: 64 } },
      { binding: 1, resource: { buffer: voxelBuf } },
    ],
  }));

  let depthTex = null;
  let depthView = null;
  let curW = 0, curH = 0;

  function ensureDepth(w, h) {
    if (curW === w && curH === h && depthTex) return;
    if (depthTex) depthTex.destroy();
    curW = w; curH = h;
    depthTex = device.createTexture({
      size: [w, h],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    depthView = depthTex.createView();
  }

  const ctrl = createDestructionController("webgpu", VOX_DIMS);
  let lastDt = 0.016;
  let simTime = 0;
  let pausedNow = false;

  // Validate pipelines right at startup so any WGSL error triggers automatic WebGL2 fallback!
  const valErr = await device.popErrorScope();
  if (valErr) {
    gpuCanvas.remove();
    throw new Error("WebGPU shader validation failed: " + valErr.message);
  }

  function writeFrameSlot(slotIdx, basis, sim, stressView, isDebrisPass) {
    const off = (slotIdx * FRAME_UBO_STRIDE) / 4;
    frameData.set(basis.viewProjGPU, off);
    let p = off + 16;
    frameData[p++] = basis.eye[0];   frameData[p++] = basis.eye[1];   frameData[p++] = basis.eye[2];   frameData[p++] = basis.tanHalf;
    frameData[p++] = basis.fwd[0];   frameData[p++] = basis.fwd[1];   frameData[p++] = basis.fwd[2];   frameData[p++] = basis.aspect;
    frameData[p++] = basis.right[0]; frameData[p++] = basis.right[1]; frameData[p++] = basis.right[2]; frameData[p++] = simTime;
    frameData[p++] = basis.up[0];    frameData[p++] = basis.up[1];    frameData[p++] = basis.up[2];    frameData[p++] = sim.stage;
    frameData[p++] = sim.flashPos[0]; frameData[p++] = sim.flashPos[1]; frameData[p++] = sim.flashPos[2]; frameData[p++] = sim.flashTime / 0.32;
    frameData[p++] = sim.craters.length; frameData[p++] = stressView ? 1.0 : 0.0; frameData[p++] = sim.voronoiFlash; frameData[p++] = isDebrisPass ? 1.0 : 0.0;
    frameData[p++] = TOWER_BOUNDS.minX; frameData[p++] = TOWER_BOUNDS.minY; frameData[p++] = TOWER_BOUNDS.minZ; frameData[p++] = VOX_DIMS[0];
    frameData[p++] = TOWER_BOUNDS.maxX - TOWER_BOUNDS.minX; frameData[p++] = TOWER_BOUNDS.maxY - TOWER_BOUNDS.minY; frameData[p++] = TOWER_BOUNDS.maxZ - TOWER_BOUNDS.minZ; frameData[p++] = VOX_DIMS[1];
    frameData[p++] = VOX_DIMS[2]; frameData[p++] = 0; frameData[p++] = 0; frameData[p++] = 0;
    for (let i = 0; i < MAX_CRATERS; i++) {
      const c = sim.craters[i];
      if (c) {
        frameData[p++] = c[0]; frameData[p++] = c[1]; frameData[p++] = c[2]; frameData[p++] = c[3];
      } else {
        frameData[p++] = 0; frameData[p++] = -99; frameData[p++] = 0; frameData[p++] = 0;
      }
    }
  }

  function packDust(sim, arr) {
    const n = Math.min(sim.dust.length, MAX_DUST);
    for (let i = 0; i < n; i++) {
      const d = sim.dust[i];
      const o = i * 8;
      arr[o + 0] = d.x; arr[o + 1] = d.y; arr[o + 2] = d.z; arr[o + 3] = d.scale;
      arr[o + 4] = d.age / d.maxAge; arr[o + 5] = d.kind; arr[o + 6] = i * 0.13; arr[o + 7] = 0;
    }
    return n;
  }

  return {
    id: "destruction",
    backend: "webgpu",
    usesExternalCanvas: true,
    gpuCanvas,
    maxPixels: 960000,
    defaultCamera: DEFAULT_CAMERA,

    setVisible(visible) {
      gpuCanvas.style.display = visible ? "block" : "none";
    },
    enterStep(stepIdx) {
      ctrl.enterStep(stepIdx);
      debrisCursors[0] = 0;
      debrisCursors[1] = 0;
    },
    onReset() {
      ctrl.onReset();
      debrisCursors[0] = 0;
      debrisCursors[1] = 0;
    },
    triggerAction(actionId) {
      ctrl.triggerAction(actionId);
    },
    isActionActive(actionId) {
      return ctrl.isActionActive(actionId);
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      ctrl.onCanvasClick(ndcX, ndcY, w, h, step, cam);
    },
    getTechBadge(stepIdx) {
      return ctrl.getTechBadge(stepIdx);
    },
    resize(w, h) {
      if (gpuCanvas.width !== w || gpuCanvas.height !== h) {
        gpuCanvas.width = w;
        gpuCanvas.height = h;
      }
      ensureDepth(w, h);
    },
    update(dt, paused) {
      pausedNow = paused;
      lastDt = paused ? 0 : Math.min(dt, 0.033);
      if (!paused) simTime += lastDt;
      ctrl.update(dt, paused);
    },
    render(w, h, step, split, cam) {
      if (gpuCanvas.width !== w || gpuCanvas.height !== h) {
        gpuCanvas.width = w;
        gpuCanvas.height = h;
      }
      ensureDepth(w, h);

      const stageR = split.enabled ? (step.compareRight ?? step.stage ?? 7) : (step.stage ?? 0);
      const stageL = split.enabled ? (step.compareLeft ?? 1) : stageR;
      ctrl.setActiveStages(stageL, stageR);

      const simL = ctrl.getSim(stageL);
      const simR = ctrl.getSim(stageR);
      const basis = computeCameraBasis(cam, w / Math.max(1, h));
      const stressView = ctrl.isStressView();

      const activeSides = split.enabled ? [[0, simL], [1, simR]] : [[1, simR]];

      // Upload instance buffers, dust buffers, and voxel volume (if dirty from BFS island detachment)
      const instCounts = [0, 0];
      const dustCounts = [0, 0];
      const enc = device.createCommandEncoder();

      // 1) Process queued GPU debris emits & voxel carves
      const emitStaging = new Float32Array(64 * EMIT_SLOTS);
      const emitJobs = [];
      let emitSlot = 0;

      for (const [side, sObj] of activeSides) {
        const sim = sObj.sim;
        if (sim.stage === 6 && sim.voxelDirty && sim.voxels) {
          // Sync full 48x72x48 voxel volume when reset or BFS island detachment removed floating islands
          for (let i = 0; i < VOX_COUNT; i++) voxelUpload[i] = sim.voxels[i];
          device.queue.writeBuffer(voxelBuf, 0, voxelUpload);
          sim.voxelDirty = false;
          sim.voxelCarveQueue.length = 0;
        } else if (sim.stage === 6 && sim.voxelCarveQueue.length > 0) {
          // Pure GPU compute voxel carve pass
          const carveBufData = new Float32Array(64 * 4);
          const carveBufU32 = new Uint32Array(carveBufData.buffer);
          let cSlot = 0;
          for (const ev of sim.voxelCarveQueue) {
            if (ev.reset || cSlot >= 4) continue;
            const o = cSlot * 64;
            carveBufData[o + 0] = ev.pos[0]; carveBufData[o + 1] = ev.pos[1]; carveBufData[o + 2] = ev.pos[2]; carveBufData[o + 3] = ev.radius;
            carveBufData[o + 4] = TOWER_BOUNDS.minX; carveBufData[o + 5] = TOWER_BOUNDS.minY; carveBufData[o + 6] = TOWER_BOUNDS.minZ; carveBufData[o + 7] = 0;
            carveBufData[o + 8] = TOWER_BOUNDS.maxX - TOWER_BOUNDS.minX; carveBufData[o + 9] = TOWER_BOUNDS.maxY - TOWER_BOUNDS.minY; carveBufData[o + 10] = TOWER_BOUNDS.maxZ - TOWER_BOUNDS.minZ; carveBufData[o + 11] = 0;
            carveBufU32[o + 12] = VOX_DIMS[0]; carveBufU32[o + 13] = VOX_DIMS[1]; carveBufU32[o + 14] = VOX_DIMS[2]; carveBufU32[o + 15] = 0;
            cSlot++;
          }
          sim.voxelCarveQueue.length = 0;
          if (cSlot > 0) {
            device.queue.writeBuffer(carveUbo, 0, carveBufData);
            const cp = enc.beginComputePass();
            cp.setPipeline(pipeVoxelCarve);
            for (let k = 0; k < cSlot; k++) {
              cp.setBindGroup(0, bgVoxelCarve[k]);
              cp.dispatchWorkgroups(VOX_DIMS[0] / 4, VOX_DIMS[1] / 4, VOX_DIMS[2] / 4);
            }
            cp.end();
          }
        }

        // Queue GPU compute debris emit/reset jobs
        while (sim.gpuEmitQueue.length > 0 && emitSlot < EMIT_SLOTS) {
          const ev = sim.gpuEmitQueue.shift();
          const o = emitSlot * 64;
          if (ev.reset) {
            emitStaging[o + 9] = 1.0; // resetFlag
            emitJobs.push({ side, slot: emitSlot, workgroups: GPU_DEBRIS_COUNT / 64 });
            debrisCursors[side] = 0;
          } else {
            const cnt = Math.min(ev.count || 400, 4096);
            emitStaging[o + 0] = ev.pos[0]; emitStaging[o + 1] = ev.pos[1]; emitStaging[o + 2] = ev.pos[2]; emitStaging[o + 3] = ev.radius;
            emitStaging[o + 4] = ev.power; emitStaging[o + 5] = debrisCursors[side]; emitStaging[o + 6] = cnt; emitStaging[o + 7] = (emitSeed += 0.37);
            emitStaging[o + 8] = ev.stage; emitStaging[o + 9] = 0.0;
            debrisCursors[side] = (debrisCursors[side] + cnt) % GPU_DEBRIS_COUNT;
            emitJobs.push({ side, slot: emitSlot, workgroups: Math.ceil(cnt / 64) });
          }
          emitSlot++;
        }

        instCounts[side] = sObj.packInstances(instScratch[side], MAX_INSTANCES, stressView);
        if (instCounts[side] > 0) {
          device.queue.writeBuffer(instBufs[side], 0, instScratch[side], 0, instCounts[side] * 16);
        }
        dustCounts[side] = packDust(sim, dustScratch[side]);
        if (dustCounts[side] > 0) {
          device.queue.writeBuffer(dustBufs[side], 0, dustScratch[side], 0, dustCounts[side] * 8);
        }

        writeFrameSlot(side * 2, basis, sim, stressView, false);
        writeFrameSlot(side * 2 + 1, basis, sim, stressView, true);
      }

      device.queue.writeBuffer(frameUbo, 0, frameData);
      if (emitJobs.length > 0) {
        device.queue.writeBuffer(emitUbo, 0, emitStaging);
      }
      device.queue.writeBuffer(simUbo, 0, new Float32Array([lastDt, simTime, -19.2, 0]));

      // 2) Dispatch GPU Compute Passes: Debris Emit + 8,192-Particle Debris Physics Simulation!
      {
        const cp = enc.beginComputePass();
        if (emitJobs.length > 0) {
          cp.setPipeline(pipeDebrisEmit);
          for (const j of emitJobs) {
            cp.setBindGroup(0, bgDebrisEmit[j.side][j.slot]);
            cp.dispatchWorkgroups(j.workgroups, 1, 1);
          }
        }
        if (!pausedNow && lastDt > 0) {
          cp.setPipeline(pipeDebrisSim);
          for (const [side] of activeSides) {
            cp.setBindGroup(0, bgDebrisSim[side]);
            cp.dispatchWorkgroups(GPU_DEBRIS_COUNT / 64, 1, 1);
          }
        }
        cp.end();
      }

      // 3) Render Pass (Scissor-split cleanly for Split Mode: Left Era vs Right Era!)
      const swapView = context.getCurrentTexture().createView();
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: swapView,
          clearValue: { r: 0.14, g: 0.19, b: 0.28, a: 1.0 },
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
      const drawSide = (side, sx, sw) => {
        if (sw <= 0) return;
        rp.setScissorRect(sx, 0, sw, h);

        // Pass A: Sky + Sunlit Flagstone Plaza + Stage 1 Geo-Mod CSG / Stage 6 48x72x48 Voxels (writes depth!)
        rp.setPipeline(pipeEnv);
        rp.setBindGroup(0, bgEnv[side]);
        rp.draw(3, 1, 0, 0);

        // Pass B: Hardware-Instanced PBR Structural Blocks, Voronoi Wedges, Bent Girders + 8,192 GPU Debris!
        rp.setPipeline(pipeBlock);
        rp.setVertexBuffer(0, vbPos);
        rp.setVertexBuffer(1, vbNrm);
        rp.setVertexBuffer(2, vbUv);
        rp.setIndexBuffer(ibIdx, "uint16");

        if (instCounts[side] > 0) {
          rp.setBindGroup(0, bgBlocks[side]);
          rp.drawIndexed(indexCount, instCounts[side], 0, 0, 0);
        }
        rp.setBindGroup(0, bgDebrisRender[side]);
        rp.drawIndexed(indexCount, GPU_DEBRIS_COUNT, 0, 0, 0);

        // Pass C: Depth-Tested Alpha-Blended Shockwave Rings, Blast Flash & Sunlit Dust Plumes
        if (dustCounts[side] > 0) {
          rp.setPipeline(pipeDust);
          rp.setBindGroup(0, bgDust[side]);
          rp.draw(6, dustCounts[side], 0, 0);
        }
      };

      if (split.enabled) {
        drawSide(0, 0, splitX);
        drawSide(1, splitX, w - splitX);
      } else {
        drawSide(1, 0, w);
      }

      rp.end();
      device.queue.submit([enc.finish()]);
    },
  };
}
