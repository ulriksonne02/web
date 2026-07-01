import * as THREE from 'https://esm.sh/three@0.165.0';
import { GLTFLoader } from 'https://esm.sh/three@0.165.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://esm.sh/three@0.165.0/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'https://esm.sh/three@0.165.0/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'https://esm.sh/three@0.165.0/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'https://esm.sh/three@0.165.0/examples/jsm/lines/LineGeometry.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(4, 3, 6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

// Lights
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 1);
dir.position.set(5, 10, 7.5);
scene.add(dir);

// Ground (optional)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0x303030, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Helper: create thick-line wireframe from a geometry
function makeThickWireframe(geometry, color = 0xffffff, linewidth = 0.08) {
  const edgesGeom = new THREE.EdgesGeometry(geometry);
  const posAttr = edgesGeom.getAttribute('position');
  const positions = [];

  for (let i = 0; i < posAttr.count; i++) {
    positions.push(
      posAttr.getX(i),
      posAttr.getY(i),
      posAttr.getZ(i)
    );
  }

  const lineGeom = new LineGeometry();
  lineGeom.setPositions(positions);

  const lineMat = new LineMaterial({
    color,
    linewidth,            // control thickness here
  });
  lineMat.resolution.set(window.innerWidth, window.innerHeight);

  const line = new Line2(lineGeom, lineMat);
  line.computeLineDistances();
  return line;
}

const loader = new GLTFLoader();

loader.load(
  'models/icosphere.glb',      // <-- your Blender-exported robot
  (gltf) => {
    const root = gltf.scene;
    scene.add(root);

    // For each mesh, add a thick wireframe; optionally hide solid mesh
    root.traverse((obj) => {
      if (obj.isMesh) {
        const wf = makeThickWireframe(obj.geometry, 0xffffff, 6);

        // match transform
        wf.position.copy(obj.position);
        wf.quaternion.copy(obj.quaternion);
        wf.scale.copy(obj.scale);

        // attach to same parent
        obj.parent.add(wf);

        // optional: hide solid mesh, so only lines are visible
        obj.visible = false;
      }
    });
  },
  undefined,
  (err) => console.error('Error loading robot:', err)
);

// Simple render loop (no animation)
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

// Handle resize
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);

  // update resolution on all LineMaterial instances
  scene.traverse((obj) => {
    if (obj instanceof Line2 && obj.material && obj.material.resolution) {
      obj.material.resolution.set(w, h);
    }
  });
});
