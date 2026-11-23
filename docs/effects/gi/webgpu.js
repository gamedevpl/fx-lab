// WebGPU Compute engine for Evolution of Global Illumination (1996-2026).
// Genuine WGSL compute pipelines:
//   - 32x24x32 texture_storage_3d<rgba16float> + 3D mipmap chain (Voxel Cone Tracing)
//   - Storage buffer 6x4x6 Ambient Cube Irradiance Volumes (1998-2004 Probes)
//   - Workgroup-shared-memory 8x5x8 Octahedral DDGI + Chebyshev Visibility atlases (2019 DDGI)
//   - Full-res G-Buffer + Screen-Space SSAO (2007) & SSDO/SSGI (2009) + À-Trous bilateral filter
//   - Software SDF multi-bounce GI (2022 UE5 Lumen style)
//   - 3-level Sannikov Radiance Cascades (C2 -> C1 -> C0) with depth-aware bilinear cascade merging (2023-26)

import { BAKED_LAMP, DEFAULT_CAMERA, createGiState } from "./shared.js";
import {
  VOX_INJECT_WGSL, VOX_MIP_WGSL, PROBE_BASIC_WGSL, DDGI_UPDATE_WGSL,
  GBUF_WGSL, SS_PASS_WGSL, SDF_GI_WGSL, BILAT_WGSL, RC_PASS_WGSL, COMPOSE_WGSL,
} from "./wgsl.js";

const UNIFORM_STRIDE = 256; // WebGPU minUniformBufferOffsetAlignment
const UNIFORM_BYTES = 160;  // 10 x vec4f
const UNIFORM_SLOTS = 8;    // 0=main, 1=rcC2, 2=rcC1, 3=rcC0, 4=ssB1, 5=ssB2, 6=sdfB1, 7=sdfB2

export async function createGiWebGPU(hostCanvas) {
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

  // Create sibling WebGPU canvas behind #c (which keeps opacity:0 & captures all pointer/wheel events!)
  let gpuCanvas = document.getElementById("cGpu");
  if (!gpuCanvas) {
    gpuCanvas = document.createElement("canvas");
    gpuCanvas.id = "cGpu";
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
    throw new Error("Could not acquire webgpu canvas context");
  }
  context.configure({
    device,
    format: canvasFormat,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  device.pushErrorScope("validation");

  function mkCompute(label, code) {
    const module = device.createShaderModule({ label, code });
    return device.createComputePipeline({
      label,
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  const pipeVoxInject  = mkCompute("voxInject", VOX_INJECT_WGSL);
  const pipeVoxMip     = mkCompute("voxMip", VOX_MIP_WGSL);
  const pipeProbeBasic = mkCompute("probeBasic", PROBE_BASIC_WGSL);
  const pipeDdgi       = mkCompute("ddgiUpdate", DDGI_UPDATE_WGSL);
  const pipeGbuf       = mkCompute("gbuf", GBUF_WGSL);
  const pipeSs         = mkCompute("ssPass", SS_PASS_WGSL);
  const pipeSdfGi      = mkCompute("sdfGi", SDF_GI_WGSL);
  const pipeBilat      = mkCompute("bilat", BILAT_WGSL);
  const pipeRc         = mkCompute("rcPass", RC_PASS_WGSL);

  const composeMod = device.createShaderModule({ label: "compose", code: COMPOSE_WGSL });
  const pipeCompose = device.createRenderPipeline({
    label: "compose",
    layout: "auto",
    vertex: { module: composeMod, entryPoint: "vsMain" },
    fragment: {
      module: composeMod,
      entryPoint: "fsMain",
      targets: [{ format: canvasFormat }],
    },
    primitive: { topology: "triangle-list" },
  });

  const linSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    addressModeW: "clamp-to-edge",
  });

  const uniformBuf = device.createBuffer({
    size: UNIFORM_STRIDE * UNIFORM_SLOTS,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformData = new Float32Array((UNIFORM_STRIDE * UNIFORM_SLOTS) / 4);

  // Storage buffer for 6x4x6 = 144 Ambient Cube probes x 6 vec4f = 864 vec4f = 13,824 bytes
  const probeBasicBuf = device.createBuffer({
    size: 6 * 4 * 6 * 6 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // 3D Voxel Storage Textures: 32x24x32 -> 16x12x16 -> 8x6x8 -> 4x3x4
  const voxDims = [[32, 24, 32], [16, 12, 16], [8, 6, 8], [4, 3, 4]];
  const voxTex = voxDims.map(([w, h, d]) =>
    device.createTexture({
      size: [w, h, d],
      dimension: "3d",
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    })
  );
  const voxViews = voxTex.map(t => t.createView({ dimension: "3d" }));

  // DDGI Ping-Pong Octahedral Atlases: 512x40 (8x5x8 = 320 probes x 8x8 oct texels)
  const mkTex2D = (w, h) =>
    device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
  const ddgiIrrTex = [mkTex2D(512, 40), mkTex2D(512, 40)];
  const ddgiDepTex = [mkTex2D(512, 40), mkTex2D(512, 40)];
  const ddgiIrrView = ddgiIrrTex.map(t => t.createView());
  const ddgiDepView = ddgiDepTex.map(t => t.createView());
  let ddgiPing = 0;
  let ddgiWarmed = false;

  // Fixed-size compute bind groups
  const bgVoxInject = device.createBindGroup({
    layout: pipeVoxInject.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuf, offset: 0, size: UNIFORM_BYTES } },
      { binding: 1, resource: voxViews[1] },
      { binding: 2, resource: linSampler },
      { binding: 3, resource: voxViews[0] },
    ],
  });
  const bgVoxMips = [0, 1, 2].map(lvl =>
    device.createBindGroup({
      layout: pipeVoxMip.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: voxViews[lvl] },
        { binding: 1, resource: voxViews[lvl + 1] },
      ],
    })
  );
  const bgProbeBasic = device.createBindGroup({
    layout: pipeProbeBasic.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuf, offset: 0, size: UNIFORM_BYTES } },
      { binding: 1, resource: { buffer: probeBasicBuf } },
    ],
  });
  const bgDdgi = [0, 1].map(ping => {
    const pong = 1 - ping;
    return device.createBindGroup({
      layout: pipeDdgi.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf, offset: 0, size: UNIFORM_BYTES } },
        { binding: 1, resource: ddgiIrrView[ping] },
        { binding: 2, resource: ddgiDepView[ping] },
        { binding: 3, resource: voxViews[1] },
        { binding: 4, resource: linSampler },
        { binding: 5, resource: ddgiIrrView[pong] },
        { binding: 6, resource: ddgiDepView[pong] },
      ],
    });
  });

  // Screen-size dependent resources
  let bufW = 0, bufH = 0, rcW = 64, rcH = 64;
  let screenTex = [];
  let bgGbuf = null, bgSs = null, bgSsB1 = null, bgSsB2 = null;
  let bgSdfGi = null, bgSdfB1 = null, bgSdfB2 = null;
  let bgRcC2 = null, bgRcC1 = null, bgRcC0 = null;
  let bgCompose = [null, null];

  function allocScreenTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of screenTex) t.destroy();
    screenTex = [];
    bufW = w;
    bufH = h;
    // Exact multiple of 16 so C0 (4x4), C1 (8x8), C2 (16x16) tile rcW x rcH with zero remainder!
    rcW = Math.max(64, Math.floor(w / 32) * 16);
    rcH = Math.max(64, Math.floor(h / 32) * 16);

    const gPosTex    = mkTex2D(w, h);
    const gNormTex   = mkTex2D(w, h);
    const gDirectTex = mkTex2D(w, h);
    const ssRawTex   = mkTex2D(w, h);
    const ssTmpTex   = mkTex2D(w, h);
    const ssFiltTex  = mkTex2D(w, h);
    const sdfRawTex  = mkTex2D(rcW, rcH);
    const sdfTmpTex  = mkTex2D(rcW, rcH);
    const sdfFiltTex = mkTex2D(rcW, rcH);
    const rcTex0     = mkTex2D(rcW, rcH);
    const rcTex1     = mkTex2D(rcW, rcH);
    const rcTex2     = mkTex2D(rcW, rcH);
    screenTex = [gPosTex, gNormTex, gDirectTex, ssRawTex, ssTmpTex, ssFiltTex, sdfRawTex, sdfTmpTex, sdfFiltTex, rcTex0, rcTex1, rcTex2];

    const vPos    = gPosTex.createView();
    const vNorm   = gNormTex.createView();
    const vDirect = gDirectTex.createView();
    const vSsRaw  = ssRawTex.createView();
    const vSsTmp  = ssTmpTex.createView();
    const vSsFilt = ssFiltTex.createView();
    const vSdfRaw = sdfRawTex.createView();
    const vSdfTmp = sdfTmpTex.createView();
    const vSdfOut = sdfFiltTex.createView();
    const vRc0    = rcTex0.createView();
    const vRc1    = rcTex1.createView();
    const vRc2    = rcTex2.createView();

    const uSlot = slot => ({ buffer: uniformBuf, offset: slot * UNIFORM_STRIDE, size: UNIFORM_BYTES });

    bgGbuf = device.createBindGroup({
      layout: pipeGbuf.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(0) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: vDirect },
      ],
    });

    bgSs = device.createBindGroup({
      layout: pipeSs.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(0) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: vDirect },
        { binding: 4, resource: vSsRaw },
      ],
    });
    bgSsB1 = device.createBindGroup({
      layout: pipeBilat.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(4) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: vSsRaw },
        { binding: 4, resource: vSsTmp },
      ],
    });
    bgSsB2 = device.createBindGroup({
      layout: pipeBilat.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(5) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: vSsTmp },
        { binding: 4, resource: vSsFilt },
      ],
    });

    bgSdfGi = device.createBindGroup({
      layout: pipeSdfGi.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(0) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: voxViews[1] },
        { binding: 4, resource: linSampler },
        { binding: 5, resource: vSdfRaw },
      ],
    });
    bgSdfB1 = device.createBindGroup({
      layout: pipeBilat.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(6) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: vSdfRaw },
        { binding: 4, resource: vSdfTmp },
      ],
    });
    bgSdfB2 = device.createBindGroup({
      layout: pipeBilat.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(7) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: vSdfTmp },
        { binding: 4, resource: vSdfOut },
      ],
    });

    bgRcC2 = device.createBindGroup({
      layout: pipeRc.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(1) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: voxViews[1] },
        { binding: 4, resource: linSampler },
        { binding: 5, resource: vRc0 },
        { binding: 6, resource: vRc2 },
      ],
    });
    bgRcC1 = device.createBindGroup({
      layout: pipeRc.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(2) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: voxViews[1] },
        { binding: 4, resource: linSampler },
        { binding: 5, resource: vRc2 },
        { binding: 6, resource: vRc1 },
      ],
    });
    bgRcC0 = device.createBindGroup({
      layout: pipeRc.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uSlot(3) },
        { binding: 1, resource: vPos },
        { binding: 2, resource: vNorm },
        { binding: 3, resource: voxViews[1] },
        { binding: 4, resource: linSampler },
        { binding: 5, resource: vRc1 },
        { binding: 6, resource: vRc0 },
      ],
    });

    bgCompose = [0, 1].map(ping =>
      device.createBindGroup({
        layout: pipeCompose.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: uSlot(0) },
          { binding: 1, resource: linSampler },
          { binding: 2, resource: vPos },
          { binding: 3, resource: vNorm },
          { binding: 4, resource: vDirect },
          { binding: 5, resource: vSsFilt },
          { binding: 6, resource: vSdfOut },
          { binding: 7, resource: vRc0 },
          { binding: 8, resource: vRc1 },
          { binding: 9, resource: voxViews[0] },
          { binding: 10, resource: voxViews[1] },
          { binding: 11, resource: voxViews[2] },
          { binding: 12, resource: voxViews[3] },
          { binding: 13, resource: ddgiIrrView[ping] },
          { binding: 14, resource: ddgiDepView[ping] },
          { binding: 15, resource: { buffer: probeBasicBuf } },
        ],
      })
    );
  }

  // Verify zero WGSL or pipeline validation errors before claiming WebGPU ready!
  allocScreenTargets(320, 180);
  const valErr = await device.popErrorScope();
  if (valErr) {
    gpuCanvas.remove();
    throw new Error(`WebGPU validation error: ${valErr.message}`);
  }

  const state = createGiState("WEBGPU COMPUTE");
  let voxWarmed = false;

  function writeUniformSlots(w, h, step, split, cam) {
    const aspect = w / Math.max(1, h);
    const basis = state.getCameraBasis(cam);
    const tanHalfFov = Math.tan(((cam.fovDeg || 52) * Math.PI) / 360);
    const stageLeft = split.enabled ? step.compareLeft : step.stage;
    const stageRight = split.enabled ? step.compareRight : step.stage;
    const splitX = split.enabled ? split.pos : -1.0;
    const flatLeft = step.flatAmbientSplit ? 1.0 : 0.0;
    const debugOn = state.showDebug ? 1.0 : 0.0;
    const hyst = !ddgiWarmed ? 0.0 : (state.lampMovedSinceLast ? 0.55 : 0.86);

    const base = [
      basis.pos[0], basis.pos[1], basis.pos[2], tanHalfFov,
      basis.right[0], basis.right[1], basis.right[2], aspect,
      basis.up[0], basis.up[1], basis.up[2], state.simTime,
      basis.fwd[0], basis.fwd[1], basis.fwd[2], state.frameIndex,
      state.lampPos[0], state.lampPos[1], state.lampPos[2], 9.6,
      BAKED_LAMP[0], BAKED_LAMP[1], BAKED_LAMP[2], splitX,
      stageLeft, stageRight, flatLeft, debugOn,
      w, h, rcW, rcH,
      0, 0, 0, 0,
      state.lookAwayAmt, state.moveLampAmt, hyst, 0,
    ];

    const slotOverrides = [
      [0, 0, 0, 0],           // slot 0: main
      [2, 16, 1.72, 8.50],    // slot 1: rcC2
      [1, 8,  0.50, 1.85],    // slot 2: rcC1
      [0, 4,  0.03, 0.56],    // slot 3: rcC0
      [1, 0,  0, 0],          // slot 4: full-res SS bilat step 1
      [2, 0,  0, 0],          // slot 5: full-res SS bilat step 2
      [1, 1,  0, 0],          // slot 6: half-res SDF bilat step 1
      [2, 1,  0, 0],          // slot 7: half-res SDF bilat step 2
    ];
    for (let s = 0; s < UNIFORM_SLOTS; s++) {
      const off = (s * UNIFORM_STRIDE) / 4;
      uniformData.set(base, off);
      uniformData[off + 32] = slotOverrides[s][0];
      uniformData[off + 33] = slotOverrides[s][1];
      uniformData[off + 34] = slotOverrides[s][2];
      uniformData[off + 35] = slotOverrides[s][3];
    }
    device.queue.writeBuffer(uniformBuf, 0, uniformData);
    return { stageLeft, stageRight };
  }

  return {
    id: "gi",
    backend: "webgpu",
    usesExternalCanvas: true,
    gpuCanvas,
    maxPixels: 720000,
    defaultCamera: DEFAULT_CAMERA,

    setVisible(visible) {
      gpuCanvas.style.display = visible ? "block" : "none";
    },
    enterStep(stepIdx) {
      state.enterStep(stepIdx);
      if (stepIdx === 5) ddgiWarmed = false;
    },
    onReset() {
      state.onReset();
      ddgiWarmed = false;
    },
    triggerAction(actionId) {
      state.triggerAction(actionId);
    },
    isActionActive(actionId) {
      return state.isActionActive(actionId);
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      state.onCanvasClick(ndcX, ndcY, w, h, step, cam);
    },
    getTechBadge(stepIdx) {
      return state.getTechBadge(stepIdx);
    },
    resize(w, h) {
      if (gpuCanvas.width !== w || gpuCanvas.height !== h) {
        gpuCanvas.width = w;
        gpuCanvas.height = h;
      }
      allocScreenTargets(w, h);
    },
    update(dt, paused) {
      state.update(dt, paused);
    },
    render(w, h, step, split, cam) {
      if (gpuCanvas.width !== w || gpuCanvas.height !== h) {
        gpuCanvas.width = w;
        gpuCanvas.height = h;
      }
      allocScreenTargets(w, h);
      const { stageLeft, stageRight } = writeUniformSlots(w, h, step, split, cam);
      const needs = s => stageLeft === s || stageRight === s;

      const enc = device.createCommandEncoder();

      // 1) G-Buffer Compute Pass (full resolution)
      {
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeGbuf);
        cp.setBindGroup(0, bgGbuf);
        cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8), 1);
        cp.end();
      }

      // 2) 3D Voxel Radiance Injection + 3-level 3D Mipmap Chain (serves VCT, DDGI, Lumen SDF, and Radiance Cascades!)
      const voxPasses = voxWarmed ? 1 : 2;
      for (let vp = 0; vp < voxPasses; vp++) {
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeVoxInject);
        cp.setBindGroup(0, bgVoxInject);
        cp.dispatchWorkgroups(8, 6, 8); // 32x24x32
        cp.setPipeline(pipeVoxMip);
        cp.setBindGroup(0, bgVoxMips[0]);
        cp.dispatchWorkgroups(4, 3, 4); // 16x12x16
        cp.setBindGroup(0, bgVoxMips[1]);
        cp.dispatchWorkgroups(2, 2, 2); // 8x6x8
        cp.setBindGroup(0, bgVoxMips[2]);
        cp.dispatchWorkgroups(1, 1, 1); // 4x3x4
        cp.end();
      }
      voxWarmed = true;

      // 3) 1998-2004 Ambient Cube Probes Compute Pass (Stage 1)
      if (needs(1)) {
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeProbeBasic);
        cp.setBindGroup(0, bgProbeBasic);
        cp.dispatchWorkgroups(Math.ceil((6 * 4 * 6) / 64), 1, 1);
        cp.end();
      }

      // 4) 2007 SSAO & 2009 SSDO/SSGI Compute Pass + 2-Pass Edge-Stopping Bilateral Filter (Stages 2 & 3)
      if (needs(2) || needs(3)) {
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeSs);
        cp.setBindGroup(0, bgSs);
        cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8), 1);
        cp.setPipeline(pipeBilat);
        cp.setBindGroup(0, bgSsB1);
        cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8), 1);
        cp.setBindGroup(0, bgSsB2);
        cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8), 1);
        cp.end();
      }

      // 5) 2019 DDGI Octahedral + Chebyshev Compute Pass (Stage 5)
      if (needs(5)) {
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeDdgi);
        cp.setBindGroup(0, bgDdgi[ddgiPing]);
        cp.dispatchWorkgroups(8 * 5 * 8, 1, 1);
        cp.end();
        ddgiPing = 1 - ddgiPing;
        ddgiWarmed = true;
      }

      // 6) 2022 Software SDF GI (Lumen-style, half-res rcW x rcH -> 60 FPS!) + 2-pass À-Trous Bilateral Denoiser (Stage 6)
      if (needs(6)) {
        const wgX = Math.ceil(rcW / 8);
        const wgY = Math.ceil(rcH / 8);
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeSdfGi);
        cp.setBindGroup(0, bgSdfGi);
        cp.dispatchWorkgroups(wgX, wgY, 1);
        cp.setPipeline(pipeBilat);
        cp.setBindGroup(0, bgSdfB1);
        cp.dispatchWorkgroups(wgX, wgY, 1);
        cp.setBindGroup(0, bgSdfB2);
        cp.dispatchWorkgroups(wgX, wgY, 1);
        cp.end();
      }

      // 7) 2023-2026 Sannikov 3-Level Radiance Cascades Compute Pass: C2 -> C1 -> C0 (Stage 7)
      if (needs(7)) {
        const wgX = Math.ceil(rcW / 8);
        const wgY = Math.ceil(rcH / 8);
        const cp = enc.beginComputePass();
        cp.setPipeline(pipeRc);
        cp.setBindGroup(0, bgRcC2);
        cp.dispatchWorkgroups(wgX, wgY, 1);
        cp.setBindGroup(0, bgRcC1);
        cp.dispatchWorkgroups(wgX, wgY, 1);
        cp.setBindGroup(0, bgRcC0);
        cp.dispatchWorkgroups(wgX, wgY, 1);
        cp.end();
      }

      // 8) Final Fullscreen Compose Render Pass -> Swapchain
      const swapView = context.getCurrentTexture().createView();
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: swapView,
          clearValue: { r: 0.08, g: 0.08, b: 0.13, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      rp.setPipeline(pipeCompose);
      rp.setBindGroup(0, bgCompose[ddgiPing]);
      rp.draw(3, 1, 0, 0);
      rp.end();

      device.queue.submit([enc.finish()]);
    },
    finishFrame() {
      return device.queue.onSubmittedWorkDone();
    },
  };
}
