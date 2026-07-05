// ---------------------------------------------------------------------------
// Hex → RGB helper (same as original)  <ref: index=12621046 firstWord=1 lastWord=20/>
// ---------------------------------------------------------------------------
function hexToRGB(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Global fallback defaults (editable from a script tag before main.js loads)
const DEFAULT_BG   = (typeof window !== 'undefined' && window.BG_COLOR)   || '#fff';
const DEFAULT_WIRE = (typeof window !== 'undefined' && window.WIRE_COLOR) || '#000';

// ---------------------------------------------------------------------------
// Tiny mat4 library (unchanged)
// ---------------------------------------------------------------------------
const deg = Math.PI / 180;
const AUTO_ROTATE_Y_SPEED = 0.2;
const AUTO_ROTATE_X_SPEED = 0.1;

const mat4 = {
  rotateY(a){const c=Math.cos(a),s=Math.sin(a);return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);},
  rotateX(a){const c=Math.cos(a),s=Math.sin(a);return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);},
  identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); },
  normalize(v){const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l];},

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
// Shaders
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
    let halfNdc = vec2f(u.thickness) / u.resolution;
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
      offset = vec2f(cos(angle), sin(angle)) * (vec2f(u.thickness) / u.resolution);
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
// OBJ parser & wireframe builder (unchanged from previous iterations)
// ---------------------------------------------------------------------------
function parseOBJ(text) {
  const vPos = [], vNorm = [];
  const outPos = [], outCol = [];
  const n2c = (nx, ny, nz) => [0.5+0.5*nx, 0.5+0.5*ny, 0.5+0.5*nz];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') vPos.push([+parts[1], +parts[2], +parts[3]]);
    else if (tag === 'vn') vNorm.push([+parts[1], +parts[2], +parts[3]]);
    else if (tag === 'f') {
      const refs = parts.slice(1).map(ref => {
        const [vi, , ni] = ref.split('/').map(x => x === '' ? undefined : +x);
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
    const n=mat4.normalize([uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vz]);
    const c=[0.5+0.5*n[0],0.5+0.5*n[1],0.5+0.5*n[2]];
    for (const idx of tri){pos.push(v[idx][0],v[idx][1],v[idx][2]);col.push(c[0],c[1],c[2]);}
  }
  return {positions:new Float32Array(pos), colors:new Float32Array(col), vertexCount:12};
}

function trianglesToWireframe(positions, colors, vertexCount) {
  const edgeSet = new Set();
  const edges = [];
  for (let i=0; i<vertexCount; i+=3) {
    for (let e=0; e<3; e++) {
      const a=i+e, b=i+((e+1)%3);
      const key = a<b?`${a},${b}`:`${b},${a}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([a,b]); }
    }
  }

  const edgeVerts = new Float32Array(edges.length * 4 * 11);
  const edgeIdx   = new Uint32Array(edges.length * 6);
  let vi=0, ii=0, base=0;
  for (const [a,b] of edges){
    const ax=positions[a*3], ay=positions[a*3+1], az=positions[a*3+2];
    const bx=positions[b*3], by=positions[b*3+1], bz=positions[b*3+2];
    const ar=colors[a*3], ag=colors[a*3+1], ab=colors[a*3+2];
    const br=colors[b*3], bg=colors[b*3+1], bb=colors[b*3+2];
    const corners=[[0,-1,ar,ag,ab],[0,+1,ar,ag,ab],[1,-1,br,bg,bb],[1,+1,br,bg,bb]];
    for (const [c,s,cr,cg,cb] of corners){
      edgeVerts[vi++]=ax;edgeVerts[vi++]=ay;edgeVerts[vi++]=az;
      edgeVerts[vi++]=bx;edgeVerts[vi++]=by;edgeVerts[vi++]=bz;
      edgeVerts[vi++]=s; edgeVerts[vi++]=c;
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
// Renderer
// ---------------------------------------------------------------------------
class Renderer {
  constructor() {
    this.device = null;
    this.format = null;
    this.solidPipeline = null;
    this.edgePipeline = null;
    this.diskPipeline = null;
    this.models = new Map();
    this.startTime = performance.now();
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU not supported.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No adapter.');
    this.device = await adapter.requestDevice();
    this.format = navigator.gpu.getPreferredCanvasFormat();

    const depthStencil = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' };

    const solidMod = this.device.createShaderModule({ code: solidShader });
    this.solidPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: solidMod, entryPoint: 'vsMain',
        buffers: [{ arrayStride: 6*4, attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ]}],
      },
      fragment: { module: solidMod, entryPoint: 'fsMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });

    const edgeMod = this.device.createShaderModule({ code: edgeShader });
    this.edgePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: edgeMod, entryPoint: 'vsMain',
        buffers: [{ arrayStride: 11*4, attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32'   },
          { shaderLocation: 3, offset: 28, format: 'float32'   },
          { shaderLocation: 4, offset: 32, format: 'float32x3' },
        ]}],
      },
      fragment: { module: edgeMod, entryPoint: 'fsMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });

    const diskMod = this.device.createShaderModule({ code: diskShader });
    this.diskPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: diskMod, entryPoint: 'vsMain',
        buffers: [{ arrayStride: 7*4, attributes: [
          { shaderLocation: 0, offset: 0,  format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32'   },
          { shaderLocation: 2, offset: 16, format: 'float32x3' },
        ]}],
      },
      fragment: { module: diskMod, entryPoint: 'fsMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
  }

  loadModelData(id, model, label) {
    const device = this.device;
    const solidData = new Float32Array(model.vertexCount * 6);
    for (let i=0;i<model.vertexCount;i++){
      solidData[i*6+0]=model.positions[i*3+0];
      solidData[i*6+1]=model.positions[i*3+1];
      solidData[i*6+2]=model.positions[i*3+2];
      solidData[i*6+3]=model.colors[i*3+0];
      solidData[i*6+4]=model.colors[i*3+1];
      solidData[i*6+5]=model.colors[i*3+2];
    }
    const solidVB = device.createBuffer({ size: solidData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(solidVB, 0, solidData);

    const w = trianglesToWireframe(model.positions, model.colors, model.vertexCount);
    const edgeVB = device.createBuffer({ size: w.edgeVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(edgeVB, 0, w.edgeVerts);
    const edgeIB = device.createBuffer({ size: w.edgeIdx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(edgeIB, 0, w.edgeIdx);

    const diskVB = device.createBuffer({ size: w.diskVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(diskVB, 0, w.diskVerts);
    const diskIB = device.createBuffer({ size: w.diskIdx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(diskIB, 0, w.diskIdx);

    this.models.set(id, {
      label,
      solidVB, solidCount: model.vertexCount,
      edgeVB, edgeIB, edgeIdxCount: w.edgeIdx.length,
      diskVB, diskIB, diskIdxCount: w.diskIdx.length,
    });
  }
}

// ---------------------------------------------------------------------------
// View — now owns bgColor & wireColor
// ---------------------------------------------------------------------------
class View {
  constructor(renderer, canvas, options = {}) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu');
    this.context.configure({ device: renderer.device, format: renderer.format, alphaMode: 'premultiplied' });
    
        this.modelId = options.modelId || null;

    const bgHex   = options.bg  || DEFAULT_BG;
    const wireHex = options.wire || DEFAULT_WIRE;
    this.bgColor  = hexToRGB(bgHex);
    this.wireColor = hexToRGB(wireHex);

        // Safe numeric fallback: missing / empty / non-numeric attribute → default
    const toNum = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

    this.fovDeg    = toNum(options.fov, 18);
    this.fov       = this.fovDeg * deg;
    this.thickness = toNum(options.thickness, 3);

    this.camera = {
      azimuth:   35 * deg,
      elevation: 20 * deg,
      distance:  toNum(options.distance, 1.5),
      target:    [0, 0, 0],
    };

    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this.autoRotate = options.autoRotate ?? true;


    this.depthTexture = null;
    this.uniformBuffer = renderer.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.solidBindGroup = renderer.device.createBindGroup({
      layout: renderer.solidPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.edgeBindGroup = renderer.device.createBindGroup({
      layout: renderer.edgePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.diskBindGroup = renderer.device.createBindGroup({
      layout: renderer.diskPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.resize();
    this.setupEvents();
  }

  setModel(id) { this.modelId = id; }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.depthTexture) this.depthTexture.destroy();
      this.depthTexture = this.renderer.device.createTexture({
        size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
  }

  setupEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId); this.autoRotate = true;
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.camera.azimuth  -= dx * 0.01;
      this.camera.elevation -= dy * 0.01;
      this.camera.elevation = Math.max(-Math.PI/2+0.01, Math.min(Math.PI/2-0.01, this.camera.elevation));
    });
    c.addEventListener('pointerup',   () => { this.dragging = false; });
    c.addEventListener('pointercancel', () => { this.dragging = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.distance *= Math.exp(e.deltaY * 0.001);
      this.camera.distance = Math.max(0.5, Math.min(50, this.camera.distance));
    }, { passive: false });
  }

  updateUniforms() {
    const t = (performance.now() - this.renderer.startTime) / 1000;
    const canvas = this.canvas;
    const aspect = canvas.width / canvas.height;
    //const proj = mat4.perspective(Math.PI/10, aspect, 0.1, 100);
    const proj = mat4.perspective(this.fov, aspect, 0.1, 100);

    const az = this.camera.azimuth, el = this.camera.elevation;
    const eye = [
      this.camera.target[0] + this.camera.distance * Math.cos(el) * Math.sin(az),
      this.camera.target[1] + this.camera.distance * Math.sin(el),
      this.camera.target[2] + this.camera.distance * Math.cos(el) * Math.cos(az),
    ];
    const view = mat4.lookAt(eye, this.camera.target, [0,1,0]);

    let model = mat4.identity();
    if (this.autoRotate) {
      model = mat4.multiply(mat4.rotateY(t * AUTO_ROTATE_Y_SPEED), mat4.rotateX(t * AUTO_ROTATE_X_SPEED));
    }
    const mvp = mat4.multiply(proj, mat4.multiply(view, model));

    const u = new Float32Array(24);
    u.set(mvp, 0);
    u[16] = canvas.width;
    u[17] = canvas.height;
    //u[18] = parseFloat(document.getElementById('thickness-slider').value);
    u[18] = this.thickness;
    // [19] padding
    // Wireframe colour — per-view, written into the same uniform layout as before
    u[20] = this.wireColor[0];
    u[21] = this.wireColor[1];
    u[22] = this.wireColor[2];
    this.renderer.device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }

  render() {
    this.resize();
    const m = this.renderer.models.get(this.modelId);
    if (!m) return;

    this.updateUniforms();
    const r = this.renderer;
    const dev = r.device;

    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: this.bgColor[0], g: this.bgColor[1], b: this.bgColor[2], a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    });

    const wireframe = document.getElementById('wireframe-toggle').checked;
    if (wireframe) {
      pass.setPipeline(r.edgePipeline);
      pass.setBindGroup(0, this.edgeBindGroup);
      pass.setVertexBuffer(0, m.edgeVB);
      pass.setIndexBuffer(m.edgeIB, 'uint32');
      pass.drawIndexed(m.edgeIdxCount);

      pass.setPipeline(r.diskPipeline);
      pass.setBindGroup(0, this.diskBindGroup);
      pass.setVertexBuffer(0, m.diskVB);
      pass.setIndexBuffer(m.diskIB, 'uint32');
      pass.drawIndexed(m.diskIdxCount);
    } else {
      pass.setPipeline(r.solidPipeline);
      pass.setBindGroup(0, this.solidBindGroup);
      pass.setVertexBuffer(0, m.solidVB);
      pass.draw(m.solidCount);
    }

    pass.end();
    dev.queue.submit([encoder.finish()]);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const statusEl = document.getElementById("status") || { textContent: "" };

function addModelOption(id, label) {
  document.querySelectorAll('.model-select').forEach(sel => {
    if ([...sel.options].some(o => o.value === id)) return;
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = label;
    sel.appendChild(opt);
  });
}

async function main2() {

  // Guard against a missing #controls panel in HTML
  (function stubControlsIfMissing() {
    if (document.getElementById('controls')) return;
    const mk = (id, tag, props = {}) => {
      if (document.getElementById(id)) return;
      const el = Object.assign(document.createElement(tag), { id, ...props });
      el.style.display = 'none';
      document.body.appendChild(el);
    };
    mk('wireframe-toggle',   'input', { type: 'checkbox', checked: true });
    mk('thickness-slider',  'input', { type: 'range', value: 3, min: 1, max: 20 });
    mk('thickness-value',   'span',  { textContent: '3' });
    mk('auto-rotate-toggle','input', { type: 'checkbox', checked: true });
  })();


  const renderer = new Renderer();
  try { await renderer.init(); statusEl.textContent = 'Ready.'; }
  catch (err) { statusEl.textContent = '❌ ' + err.message; console.error(err); return; }

  renderer.loadModelData('cube',  buildCubeModel(),        'Cube');
  renderer.loadModelData('tetra', buildTetrahedronModel(), 'Tetrahedron');
  addModelOption('cube',  'Cube');
  addModelOption('tetra', 'Tetrahedron');

  const views = [];
  const pendingLoads = new Map();

  async function ensureModelLoaded(url, id = url, label = url.split('/').pop()) {
    if (renderer.models.has(id)) return id;
    if (pendingLoads.has(id)) return pendingLoads.get(id);
    const promise = (async () => {
      try {
        statusEl.textContent = `⏳ Loading ${label}…`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const model = parseOBJ(text);
        if (!model.vertexCount) throw new Error('No geometry');
        normalizeModel(model.positions);
        renderer.loadModelData(id, model, label);
        addModelOption(id, label);
        statusEl.textContent = `✅ ${label}`;
        return id;
      } catch (err) {
        statusEl.textContent = `❌ ${err.message}`; console.error(err); return null;
      } finally { pendingLoads.delete(id); }
    })();
    pendingLoads.set(id, promise);
    return promise;
  }

  document.querySelectorAll('.view-port').forEach(wrap => {
    const canvas = wrap.querySelector('canvas');
    const sel    = wrap.querySelector('.model-select');

    const view = new View(renderer, canvas, {
      modelId: wrap.dataset.model || 'cube',
      autoRotate: true,
      bg:  wrap.dataset.bg,
      wire: wrap.dataset.wire,
      
      fov:        wrap.dataset.fov,
      distance:   wrap.dataset.distance,
      thickness:  wrap.dataset.thickness,
    });

    if (sel) sel.addEventListener('change', () => view.setModel(sel.value));

    // Drag-and-drop (per view)
    const c = view.canvas;
    c.addEventListener('dragover', e => { e.preventDefault(); wrap.style.outline = '4px dashed #9cf'; });
    c.addEventListener('dragleave', () => { wrap.style.outline = 'none'; });
    c.addEventListener('drop', e => {
      e.preventDefault(); wrap.style.outline = 'none';
      const f = e.dataTransfer.files[0]; if (!f) return;
      const id = 'file-' + Math.random().toString(36).slice(2);
      statusEl.textContent = `⏳ Loading ${f.name}…`;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const model = parseOBJ(reader.result);
          if (!model.vertexCount) { statusEl.textContent = '❌ No geometry.'; return; }
          normalizeModel(model.positions);
          renderer.loadModelData(id, model, f.name);
          addModelOption(id, f.name);
          view.setModel(id);
          if (sel) sel.value = id;
          statusEl.textContent = `✅ ${f.name}`;
        } catch (err) { statusEl.textContent = '❌ ' + err.message; console.error(err); }
      };
      reader.readAsText(f);
    });

    views.push({ view, wrap, sel });
  });

  // Resolve asynchronous defaults (data-model="url.obj")
  for (const { view, wrap, sel } of views) {
    const dm = wrap.dataset.model || 'cube';
    if (dm !== 'cube' && dm !== 'tetra') {
      ensureModelLoaded(dm).then(id => {
        if (id) { view.setModel(id); if (sel) sel.value = id; }
        else { view.setModel('cube'); if (sel) sel.value = 'cube'; }
      });
    } else {
      view.setModel(dm);
      if (sel) sel.value = dm;
    }
  }

  // Global controls
  const wireframeToggle  = document.getElementById('wireframe-toggle');
  const thicknessSlider  = document.getElementById('thickness-slider');
  const thicknessValue   = document.getElementById('thickness-value');
  const autoRotateToggle = document.getElementById('auto-rotate-toggle');

  thicknessSlider.addEventListener('input', () => { thicknessValue.textContent = thicknessSlider.value; });
  autoRotateToggle.addEventListener('change', () => views.forEach(v => v.view.autoRotate = autoRotateToggle.checked));
  views.forEach(v => v.view.autoRotate = autoRotateToggle.checked);
  window.addEventListener('resize', () => views.forEach(v => v.view.resize()));

  function frame() { views.forEach(v => v.view.render()); requestAnimationFrame(frame); }
  frame();
}

main2();
