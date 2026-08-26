import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/** Renderer, camera, lighting and orbit controls. Nothing box-specific lives here. */
export class Viewer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  readonly ground: THREE.Mesh
  private raf = 0
  private onFrame: ((dt: number) => void) | null = null

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 8000)
    this.camera.position.set(260, 210, 340)

    // A procedural room gives the board a believable soft reflection without
    // shipping an HDR file — the page has to stay self-contained.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.55

    const key = new THREE.DirectionalLight(0xffffff, 2.1)
    key.position.set(180, 320, 220)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0012
    key.shadow.normalBias = 0.6
    const c = key.shadow.camera
    c.near = 1; c.far = 1600; c.left = -420; c.right = 420; c.top = 420; c.bottom = -420
    this.scene.add(key)

    const fill = new THREE.DirectionalLight(0xdce6ff, 0.55)
    fill.position.set(-240, 140, -180)
    this.scene.add(fill)

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    )
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 40
    this.controls.maxDistance = 2400
    this.controls.autoRotateSpeed = 1.4
    this.controls.target.set(0, 40, 0)

    addEventListener('resize', () => this.resize())
    this.resize()
  }

  resize() {
    const w = this.canvas.clientWidth || 1
    const h = this.canvas.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Frame the camera on a bounding box. */
  frame(box: THREE.Box3, azimuth = 0.75, elevation = 0.42) {
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.length() * 0.5, 1)
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.15
    this.controls.target.copy(center)
    this.camera.position.set(
      center.x + dist * Math.cos(elevation) * Math.sin(azimuth),
      center.y + dist * Math.sin(elevation),
      center.z + dist * Math.cos(elevation) * Math.cos(azimuth),
    )
    this.camera.near = Math.max(0.5, dist / 500)
    this.camera.far = dist * 40
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  /**
   * Keeps a moving object framed without stealing the orbit angle the user
   * picked: only the target and the distance are eased, never the direction.
   */
  followFrame(box: THREE.Box3, dt: number, strength = 3.2) {
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.length() * 0.5, 1)
    const want = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.15
    const k = 1 - Math.exp(-strength * dt)

    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    const current = this.camera.position.distanceTo(this.controls.target)
    this.controls.target.lerp(center, k)
    this.camera.position.copy(this.controls.target).addScaledVector(dir, THREE.MathUtils.lerp(current, want, k))
  }

  start(onFrame: (dt: number) => void) {
    this.onFrame = onFrame
    if (this.raf) return
    let last = performance.now()
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      this.onFrame?.(dt)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    this.raf = requestAnimationFrame(loop)
  }
}
