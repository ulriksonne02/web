const statusEl         = document.getElementById("status");
const canvas           = document.getElementById("gpu-canvas");
const fileInput        = document.getElementById("file-input");
const presetSelect     = document.getElementById("preset-select");
const wireframeToggle  = document.getElementById("wireframe-toggle");
const thicknessSlider  = document.getElementById("thickness-slider");
const thicknessValue   = document.getElementById("thickness-value");
const autoRotateToggle = document.getElementById("auto-rotate-toggle");
// Editable from HTML console, buttons, or <input type=color>


let bgColor = [0.03, 0.03, 0.06]; // default dark blue
window.setBgColor = (r, g, b) => { bgColor = [r, g, b]; };
window.setBgHex   = (hex) => {
  const n = parseInt(hex.replace("#",""), 16);
  bgColor = [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255];
};

function hexToRGB(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const BG_COLOR   = hexToRGB(window.BG_COLOR   || "#000000");
const WIRE_COLOR = hexToRGB(window.WIRE_COLOR || "#ffffff");

// ---------------------------------------------------------------------------
// mat4 helpers (column-major)
// ---------------------------------------------------------------------------
const mat4 = {
  rotateZ(a){const c=Math.cos(a),s=Math.sin(a);return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]);},
  identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); },

  perspective(fovY, aspect, near, far) {
    const f = 1.0 / Math.tan(fovY / 2);
    const nf = 1.0 / (near - far);
    return new Float32Array([
      f/aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, far*nf, -1,
      0, 0, near*far*nf, 0,
    ]);
  },

  multiply(a, b) {
    const r = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k*4 + row] * b[c*4 + k];
        r[c*4 + row] = s;
      }
    return r;
  },

  rotateY(a){const c=Math.cos(a),s=Math.sin(a);return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);},
  rotateX(a){const c=Math.cos(a),s=Math.sin(a);return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);},

  translate(x,y,z){return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);},
  normalize(v){const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l];},

  lookAt(eye, target, up) {
    const z = [eye[0]-target[0], eye[1]-target[1], eye[2]-target[2]];
    const zl = Math.hypot(z[0],z[1],z[2]) || 1;
    z[0]/=zl; z[1]/=zl; z[2]/=zl;
    const x = [up[1]*z[2]-up[2]*z[1], up[2]*z[0]-up[0]*z[2], up[0]*z[1]-up[1]*z[0]];
    const xl = Math.hypot(x[0],x[1],x[2]) || 1;
    x[0]/=xl; x[1]/=xl; x[2]/=xl;
    const y = [z[1]*x[2]-z[2]*x[1], z[2]*x[0]-z[0]*x[2], z[0]*x[1]-z[1]*x[0]];
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0]*eye[0]+x[1]*eye[1]+x[2]*eye[2]),
      -(y[0]*eye[0]+y[1]*eye[1]+y[2]*eye[2]),
      -(z[0]*eye[0]+z[1]*eye[1]+z[2]*eye[2]),
      1,
    ]);
  },
};

// ---------------------------------------------------------------------------
// Orbit camera state — different default angle
// ---------------------------------------------------------------------------
const deg = Math.PI / 180;
const cam = {
  azimuth:   35 * deg,   // around Y
  elevation: 20 * deg,  // up/down
  distance:  1.5,        // zoom
  roll:      0 * deg, 
  target: [0, 0, 0],
};

const AUTO_ROTATE_Y_SPEED = 0.2;   // around Y (existing)
const AUTO_ROTATE_X_SPEED = 0.1;   // around X (new — "another direction")

// ---------------------------------------------------------------------------
// OBJ parser
// ---------------------------------------------------------------------------
function parseOBJ(text) {
  const vPos = [], vNorm = [];
  const outPos = [], outCol = [];
  const n2c = (nx, ny, nz) => [0.5+0.5*nx, 0.5+0.5*ny, 0.5+0.5*nz];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === "v") vPos.push([+parts[1], +parts[2], +parts[3]]);
    else if (tag === "vn") vNorm.push([+parts[1], +parts[2], +parts[3]]);
    else if (tag === "f") {
      const refs = parts.slice(1).map(ref => {
        const [vi, , ni] = ref.split("/").map(x => x === "" ? undefined : +x);
        return { v: vi - 1, n: ni !== undefined ? ni - 1 : undefined };
      });
      for (let i = 1; i < refs.length - 1; i++) {
        const tri = [refs[0], refs[i], refs[i+1]];
        const p0=vPos[tri[0].v], p1=vPos[tri[1].v], p2=vPos[tri[2].v];
        const ux=p1[0]-p0[0], uy=p1[1]-p0[1], uz=p1[2]-p0[2];
        const vx=p2[0]-p0[0], vy=p2[1]-p0[1], vz=p2[2]-p0[2];
        const fn = mat4.normalize([uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx]);
        for (const r of tri) {
          outPos.push(...vPos[r.v]);
          const useN = (r.n !== undefined && vNorm[r.n]) ? vNorm[r.n] : fn;
          outCol.push(...n2c(useN[0], useN[1], useN[2]));
        }
      }
    }
  }
  return { positions: new Float32Array(outPos), colors: new Float32Array(outCol), vertexCount: outPos.length / 3 };
}

function normalizeModel(positions) {
  let mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity];
  for (let i=0;i<positions.length;i+=3) for (let k=0;k<3;k++) {
    if (positions[i+k]<mn[k]) mn[k]=positions[i+k];
    if (positions[i+k]>mx[k]) mx[k]=positions[i+k];
  }
  const c=[(mn[0]+mx[0])/2,(mn[1]+mx[1])/2,(mn[2]+mx[2])/2];
  const s=2/(Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2])||1);
  for (let i=0;i<positions.length;i+=3) for (let k=0;k<3;k++) positions[i+k]=(positions[i+k]-c[k])*s;
}

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------
function buildCubeModel() {
  const p = new Float32Array([
     1,-1,-1, 1,1,-1, 1,1,1, 1,-1,-1, 1,1,1, 1,-1,1,
    -1,-1,1, -1,1,1, -1,1,-1, -1,-1,1, -1,1,-1, -1,-1,-1,
    -1,1,-1, -1,1,1, 1,1,1, -1,1,-1, 1,1,1, 1,1,-1,
    -1,-1,1, -1,-1,-1, 1,-1,-1, -1,-1,1, 1,-1,-1, 1,-1,1,
    -1,-1,1, 1,-1,1, 1,1,1, -1,-1,1, 1,1,1, -1,1,1,
     1,-1,-1, -1,-1,-1, -1,1,-1, 1,-1,-1, -1,1,-1, 1,1,-1,
  ]);
  const faceNorms=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const colors=new Float32Array(36*3);
  for (let f=0;f<6;f++){const n=faceNorms[f];const r=0.5+0.5*n[0],g=0.5+0.5*n[1],b=0.5+0.5*n[2];
    for(let v=0;v<6;v++){colors[(f*6+v)*3]=r;colors[(f*6+v)*3+1]=g;colors[(f*6+v)*3+2]=b;}}
  return {positions:p, colors, vertexCount:36};
}

function buildTetrahedronModel() {
  const a=1.0; const v=[[a,a,a],[-a,-a,a],[-a,a,-a],[a,-a,-a]];
  const tris=[[0,1,2],[0,3,1],[0,2,3],[1,3,2]];
  const pos=[], col=[];
  for (const tri of tris){
    const p0=v[tri[0]],p1=v[tri[1]],p2=v[tri[2]];
    const ux=p1[0]-p0[0],uy=p1[1]-p0[1],uz=p1[2]-p0[2];
    const vx=p2[0]-p0[0],vy=p2[1]-p0[1],vz=p2[2]-p0[2];
    const n=mat4.normalize([uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx]);
    const c=[0.5+0.5*n[0],0.5+0.5*n[1],0.5+0.5*n[2]];
    for (const idx of tri){pos.push(v[idx][0],v[idx][1],v[idx][2]);col.push(c[0],c[1],c[2]);}
  }
  return {positions:new Float32Array(pos), colors:new Float32Array(col), vertexCount:12};
}

// ---------------------------------------------------------------------------
// Build wireframe geometry: edge quads + round-cap disks at vertices.
//   Edge vertex: posA(3) posB(3) side(1) corner(1) color(3) = 11 floats
//   Disk vertex: centerPos(3) angle(1) color(3) = 7 floats
// ---------------------------------------------------------------------------
function trianglesToWireframe(positions, colors, vertexCount) {
  const edgeSet = new Set();
  const edges = [];
  for (let i=0;i<vertexCount;i+=3){
    for (let e=0;e<3;e++){
      const a=i+e, b=i+((e+1)%3);
      const key = a<b?`${a},${b}`:`${b},${a}`;
      if(!edgeSet.has(key)){edgeSet.add(key);edges.push([a,b]);}
    }
  }

  const edgeVerts = new Float32Array(edges.length * 4 * 11);
  const edgeIdx   = new Uint32Array(edges.length * 6);
  let vi=0, ii=0, base=0;
  for (const [a,b] of edges){
    const ax=positions[a*3],ay=positions[a*3+1],az=positions[a*3+2];
    const bx=positions[b*3],by=positions[b*3+1],bz=positions[b*3+2];
    const ar=colors[a*3],ag=colors[a*3+1],ab=colors[a*3+2];
    const br=colors[b*3],bg=colors[b*3+1],bb=colors[b*3+2];
    const corners=[[0,-1,ar,ag,ab],[0,+1,ar,ag,ab],[1,-1,br,bg,bb],[1,+1,br,bg,bb]];
    for (const [c,s,cr,cg,cb] of corners){
      edgeVerts[vi++]=ax;edgeVerts[vi++]=ay;edgeVerts[vi++]=az;
      edgeVerts[vi++]=bx;edgeVerts[vi++]=by;edgeVerts[vi++]=bz;
      edgeVerts[vi++]=s;edgeVerts[vi++]=c;
      edgeVerts[vi++]=cr;edgeVerts[vi++]=cg;edgeVerts[vi++]=cb;
    }
    edgeIdx[ii++]=base+0;edgeIdx[ii++]=base+1;edgeIdx[ii++]=base+2;
    edgeIdx[ii++]=base+2;edgeIdx[ii++]=base+1;edgeIdx[ii++]=base+3;
    base+=4;
  }

  const N = 24;
  const vertexUsed = new Set();
  for (const [a,b] of edges){vertexUsed.add(a);vertexUsed.add(b);}
  const diskCount = vertexUsed.size;
  const vertsPerDisk = N + 2;
  const diskVerts = new Float32Array(diskCount * vertsPerDisk * 7);
  const diskIdx   = new Uint32Array(diskCount * N * 3);
  let dvi=0, dii=0, dbase=0;
  for (const v of vertexUsed){
    const px=positions[v*3],py=positions[v*3+1],pz=positions[v*3+2];
    const cr=colors[v*3],cg=colors[v*3+1],cb=colors[v*3+2];
    diskVerts[dvi++]=px;diskVerts[dvi++]=py;diskVerts[dvi++]=pz;
    diskVerts[dvi++]=-1.0;
    diskVerts[dvi++]=cr;diskVerts[dvi++]=cg;diskVerts[dvi++]=cb;
    for (let i=0;i<=N;i++){
      const ang=(i/N)*Math.PI*2;
      diskVerts[dvi++]=px;diskVerts[dvi++]=py;diskVerts[dvi++]=pz;
      diskVerts[dvi++]=ang;
      diskVerts[dvi++]=cr;diskVerts[dvi++]=cg;diskVerts[dvi++]=cb;
    }
    for (let i=0;i<N;i++){
      diskIdx[dii++]=dbase+0;
      diskIdx[dii++]=dbase+1+i;
      diskIdx[dii++]=dbase+1+i+1;
    }
    dbase += vertsPerDisk;
  }

  return {
    edgeVerts, edgeIdx, edgeCount: edges.length,
    diskVerts, diskIdx,
    diskVertCount: diskCount * vertsPerDisk,
    diskIdxCount:  diskCount * N * 3,
  };
}

// ---------------------------------------------------------------------------
// Shaders (all white)
// ---------------------------------------------------------------------------
const solidShader = /* wgsl */ `
  struct Uniforms { mvp : mat4x4f };
  @group(0) @binding(0) var<uniform> u : Uniforms;
  struct VOut { @builtin(position) pos : vec4f, @location(0) color : vec3f };
  @vertex fn vsMain(@location(0) p : vec3f, @location(1) c : vec3f) -> VOut {
    var o : VOut; o.pos = u.mvp * vec4f(p, 1.0); o.color = c; return o;
  }
  @fragment fn fsMain(in : VOut) -> @location(0) vec4f { return vec4f(in.color, 1.0); }
`;

const edgeShader = /* wgsl */ `
  struct Uniforms { mvp: mat4x4f, resolution: vec2f, thickness: f32, wireColor: vec3f };
  @group(0) @binding(0) var<uniform> u : Uniforms;
  struct VOut { @builtin(position) pos : vec4f, @location(0) color : vec3f };
  @vertex fn vsMain(
    @location(0) posA: vec3f, @location(1) posB: vec3f,
    @location(2) side: f32, @location(3) corner: f32, @location(4) col: vec3f,
  ) -> VOut {
    var out : VOut;
    let base  = mix(posA, posB, corner);
    let other = mix(posB, posA, corner);
    let clipBase  = u.mvp * vec4f(base, 1.0);
    let clipOther = u.mvp * vec4f(other, 1.0);
    let ndcBase  = clipBase.xy  / clipBase.w;
    let ndcOther = clipOther.xy / clipOther.w;
    let dir = ndcOther - ndcBase;
    let len = length(dir);
    var perp = vec2f(0.0, 0.0);
    if (len > 1e-6) { perp = vec2f(-dir.y, dir.x) / len; }
    let halfNdc = u.thickness / u.resolution;
    let newNdc = ndcBase + perp * side * halfNdc;
    out.pos   = vec4f(newNdc * clipBase.w, clipBase.z, clipBase.w);
    out.color = col;
    return out;
  }
  @fragment fn fsMain(in : VOut) -> @location(0) vec4f {
    return vec4f(u.wireColor, 1.0);
  }
`;

const diskShader = /* wgsl */ `
  struct Uniforms { mvp: mat4x4f, resolution: vec2f, thickness: f32, wireColor: vec3f };
  @group(0) @binding(0) var<uniform> u : Uniforms;
  struct VOut { @builtin(position) pos : vec4f, @location(0) color : vec3f };
  @vertex fn vsMain(
    @location(0) centerPos: vec3f, @location(1) angle: f32, @location(2) col: vec3f,
  ) -> VOut {
    var out : VOut;
    let clipC = u.mvp * vec4f(centerPos, 1.0);
    let ndcC = clipC.xy / clipC.w;
    var offset = vec2f(0.0, 0.0);
    if (angle >= 0.0) {
      offset = vec2f(cos(angle), sin(angle)) * (u.thickness / u.resolution);
    }
    let newNdc = ndcC + offset;
    out.pos = vec4f(newNdc * clipC.w, clipC.z, clipC.w);
    out.color = col;
    return out;
  }
  @fragment fn fsMain(in : VOut) -> @location(0) vec4f {
    return vec4f(u.wireColor, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Renderer state
// ---------------------------------------------------------------------------
let device, context, format;
let solidPipeline, edgePipeline, diskPipeline;
let uniformBuffer, depthTexture;
let currentModel = null;

async function init() {
  if (!navigator.gpu) { statusEl.textContent = "❌ WebGPU not supported."; return; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { statusEl.textContent = "❌ No adapter."; return; }
  device = await adapter.requestDevice();
  context = canvas.getContext("webgpu");
  format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const depthStencil = {
    format: "depth24plus",
    depthWriteEnabled: true,
    depthCompare: "less-equal",
  };

  // Solid pipeline
  const solidMod = device.createShaderModule({ code: solidShader });
  solidPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: solidMod, entryPoint: "vsMain",
      buffers: [{ arrayStride: 6*4, attributes: [
        { shaderLocation: 0, offset: 0,  format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
      ]}],
    },
    fragment: { module: solidMod, entryPoint: "fsMain", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil,
  });

  // Edge pipeline
  const edgeMod = device.createShaderModule({ code: edgeShader });
  edgePipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: edgeMod, entryPoint: "vsMain",
      buffers: [{ arrayStride: 11*4, attributes: [
        { shaderLocation: 0, offset: 0,  format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32"   },
        { shaderLocation: 3, offset: 28, format: "float32"   },
        { shaderLocation: 4, offset: 32, format: "float32x3" },
      ]}],
    },
    fragment: { module: edgeMod, entryPoint: "fsMain", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil,
  });

  // Disk pipeline
  const diskMod = device.createShaderModule({ code: diskShader });
  diskPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: diskMod, entryPoint: "vsMain",
      buffers: [{ arrayStride: 7*4, attributes: [
        { shaderLocation: 0, offset: 0,  format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32"   },
        { shaderLocation: 2, offset: 16, format: "float32x3" },
      ]}],
    },
    fragment: { module: diskMod, entryPoint: "fsMain", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil,
  });

  // Uniform buffer: mvp(64) + resolution(8) + thickness(4) + pad(4) = 80 bytes
  uniformBuffer = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  if (window.DEFAULT_MODEL) {
    loadOBJURL(window.DEFAULT_MODEL, window.DEFAULT_MODEL.split("/").pop());
  } else {
    loadModelData(buildCubeModel(), "Cube");
  }

  // --- UI events ---
  fileInput.addEventListener("change", e => { const f=e.target.files[0]; if(f) loadOBJFile(f); });
  presetSelect.addEventListener("change", () => {
    if (presetSelect.value === "cube") loadModelData(buildCubeModel(), "Cube");
    else if (presetSelect.value === "tetra") loadModelData(buildTetrahedronModel(), "Tetrahedron");
  });
  thicknessSlider.addEventListener("input", () => {
    thicknessValue.textContent = thicknessSlider.value;
  });
  canvas.addEventListener("dragover", e => { e.preventDefault(); canvas.style.borderColor="#9cf"; });
  canvas.addEventListener("dragleave", () => canvas.style.borderColor="#333");
  canvas.addEventListener("drop", e => {
    e.preventDefault(); canvas.style.borderColor="#333";
    const f=e.dataTransfer.files[0]; if(f) loadOBJFile(f);
  });
  window.addEventListener("resize", () => {
    const w=Math.max(1,canvas.clientWidth), h=Math.max(1,canvas.clientHeight);
    if (canvas.width!==w || canvas.height!==h){
      canvas.width=w; canvas.height=h;
      depthTexture.destroy();
      depthTexture=device.createTexture({ size:[w,h], format:"depth24plus", usage:GPUTextureUsage.RENDER_ATTACHMENT });
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "q") cam.roll -= 2 * deg;
    if (e.key === "e") cam.roll += 2 * deg;
  });

  // --- Orbit camera: drag to rotate, wheel to zoom ---
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    autoRotateToggle.checked = true;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    cam.azimuth   -= dx * 0.01;
    cam.elevation  -= dy * 0.01;
    cam.elevation = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, cam.elevation));
  });
  canvas.addEventListener("pointerup",   () => { dragging = false; });
  canvas.addEventListener("pointercancel", () => { dragging = false; });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.distance *= Math.exp(e.deltaY * 0.001);
    cam.distance = Math.max(0.5, Math.min(50, cam.distance));
  }, { passive: false });

  // --- Render loop ---
  const start = performance.now();
  const uniformData = new Float32Array(24);
  function render() {
    
    const t = (performance.now() - start) / 1000;
    const aspect = canvas.width / canvas.height;
    const proj  = mat4.perspective(Math.PI/10, aspect, 0.1, 100);

    //let az = cam.azimuth, el = cam.elevation;
    //if (autoRotateToggle.checked) az += t * AUTO_ROTATE_Y_SPEED;
    let az = cam.azimuth, el = cam.elevation;   
    const eye = [
      cam.target[0] + cam.distance * Math.cos(el) * Math.sin(az),
      cam.target[1] + cam.distance * Math.sin(el),
      cam.target[2] + cam.distance * Math.cos(el) * Math.cos(az),
    ];
    //const eye = [0, 0, .5]; 
    const view = mat4.lookAt(eye, cam.target, [0, 1, 0]);

    // Tumble the model on a second axis when auto-rotating
    let model = mat4.identity();
    if (autoRotateToggle.checked) {
      model = mat4.multiply(mat4.rotateY(t * AUTO_ROTATE_Y_SPEED), mat4.rotateX(t * AUTO_ROTATE_X_SPEED));
    }

    const mvp = mat4.multiply(proj, mat4.multiply(view, model));


    uniformData.set(mvp, 0);
    uniformData[16] = canvas.width;
    uniformData[17] = canvas.height;
    uniformData[18] = parseFloat(thicknessSlider.value);
    // pad at [19], color at [20..22] (offset 80, 16-byte aligned)
    // uniformData[20] = window.WIRE_COLOR[0];
    // uniformData[21] = window.WIRE_COLOR[1];
    // uniformData[22] = window.WIRE_COLOR[2];
    uniformData[20] = WIRE_COLOR[0];
    uniformData[21] = WIRE_COLOR[1];
    uniformData[22] = WIRE_COLOR[2];
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    if (currentModel) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: BG_COLOR[0], g: BG_COLOR[1], b: BG_COLOR[2], a: 1 },
          loadOp: "clear", storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "store",
        },
      });

      if (wireframeToggle.checked) {
        pass.setPipeline(edgePipeline);
        pass.setBindGroup(0, device.createBindGroup({
          layout: edgePipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        }));
        pass.setVertexBuffer(0, currentModel.edgeVB);
        pass.setIndexBuffer(currentModel.edgeIB, "uint32");
        pass.drawIndexed(currentModel.edgeIdxCount);

        pass.setPipeline(diskPipeline);
        pass.setBindGroup(0, device.createBindGroup({
          layout: diskPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        }));
        pass.setVertexBuffer(0, currentModel.diskVB);
        pass.setIndexBuffer(currentModel.diskIB, "uint32");
        pass.drawIndexed(currentModel.diskIdxCount);
      } else {
        pass.setPipeline(solidPipeline);
        pass.setBindGroup(0, device.createBindGroup({
          layout: solidPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        }));
        pass.setVertexBuffer(0, currentModel.solidVB);
        pass.draw(currentModel.solidCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    requestAnimationFrame(render);
  }
  render();
}

function loadModelData(model, label) {
  const solidData = new Float32Array(model.vertexCount * 6);
  for (let i=0;i<model.vertexCount;i++){
    solidData[i*6+0]=model.positions[i*3+0];
    solidData[i*6+1]=model.positions[i*3+1];
    solidData[i*6+2]=model.positions[i*3+2];
    solidData[i*6+3]=model.colors[i*3+0];
    solidData[i*6+4]=model.colors[i*3+1];
    solidData[i*6+5]=model.colors[i*3+2];
  }
  const solidVB = device.createBuffer({
    size: solidData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(solidVB, 0, solidData);

  const w = trianglesToWireframe(model.positions, model.colors, model.vertexCount);
  const edgeVB = device.createBuffer({
    size: w.edgeVerts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(edgeVB, 0, w.edgeVerts);
  const edgeIB = device.createBuffer({
    size: w.edgeIdx.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(edgeIB, 0, w.edgeIdx);
  const diskVB = device.createBuffer({
    size: w.diskVerts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(diskVB, 0, w.diskVerts);
  const diskIB = device.createBuffer({
    size: w.diskIdx.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(diskIB, 0, w.diskIdx);

  currentModel = {
    solidVB, solidCount: model.vertexCount,
    edgeVB, edgeIB, edgeIdxCount: w.edgeIdx.length,
    diskVB, diskIB, diskIdxCount: w.diskIdx.length,
  };
  statusEl.textContent =
    `✅ ${label} — ${model.vertexCount/3|0} tris, ${w.edgeCount} edges, rounded joins`;
}

async function loadOBJURL(url, label) {
  statusEl.textContent = `⏳ Loading ${label}…`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const model = parseOBJ(text);
    if (!model.vertexCount) { statusEl.textContent = "❌ No geometry."; return; }
    normalizeModel(model.positions);
    loadModelData(model, label);
  } catch (err) {
    statusEl.textContent = "❌ " + err.message;
    console.error(err);
  }
}


function loadOBJFile(file) {
  statusEl.textContent = `⏳ Loading ${file.name}…`;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const model = parseOBJ(reader.result);
      if (!model.vertexCount) { statusEl.textContent = "❌ No geometry."; return; }
      normalizeModel(model.positions);
      loadModelData(model, file.name);
    } catch (err) {
      statusEl.textContent = "❌ " + err.message;
      console.error(err);
    }
  };
  reader.readAsText(file);
}

init().catch(err => { statusEl.textContent = "❌ " + err.message; console.error(err); });
