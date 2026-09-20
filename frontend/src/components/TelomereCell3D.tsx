// 3D "representative cell" view: chromosomes with telomere caps whose length
// and colour follow the simulation's per-cycle statistics (see telomereCell.ts
// for how the cell is reconstructed -- an illustration of the population's
// typical cell, not a measured single cell). Default export so Simulate can
// React.lazy() it: three.js only downloads when the view is opened.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import type { SimulationRun } from '../api/types'
import { STAGE_LABEL, cellFrameAt, chromosomeCount, firstFrameAtStage, lastLiveFrame, telomereColor } from './telomereCell'
import type { CellStage } from './telomereCell'

const RING_RADIUS = 2.5
const CAP_MAX = 0.55 // world-units length of a cap at initial telomere length
const STAGE_TONE: Record<CellStage, string> = {
  normal: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  eroding: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  critical: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  senescent: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  extinct: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
}

interface Chromosome {
  group: THREE.Group
  bodyMats: THREE.MeshStandardMaterial[]
  caps: THREE.Mesh[] // [top, bottom]
  half: number
}

interface SceneState {
  scene: THREE.Scene
  chromosomes: Chromosome[]
  bridges: THREE.Group
  renderer: THREE.WebGLRenderer
  controls: OrbitControls
  camera: THREE.PerspectiveCamera
  dispose: () => void
  frameStage: CellStage
  time: number
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

function buildScene(canvas: HTMLCanvasElement, nChrom: number, dark: boolean): SceneState {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
  camera.position.set(0, 2.2, 8.4)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.enablePan = false
  controls.minDistance = 4
  controls.maxDistance = 14
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.9

  scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x1e293b : 0xcbd5e1, dark ? 0.9 : 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(4, 6, 5)
  scene.add(key)

  // Nucleus envelope: faint translucent shell + wire lattice.
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(3.5, 48, 32),
    new THREE.MeshStandardMaterial({ color: dark ? 0x38bdf8 : 0x60a5fa, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
  )
  scene.add(shell)
  const lattice = new THREE.Mesh(
    new THREE.IcosahedronGeometry(3.52, 2),
    new THREE.MeshBasicMaterial({ color: dark ? 0x475569 : 0x94a3b8, wireframe: true, transparent: true, opacity: 0.18 }),
  )
  scene.add(lattice)

  const chromosomes: Chromosome[] = []
  const ring = new THREE.Group()
  scene.add(ring)
  for (let k = 0; k < nChrom; k++) {
    const half = 0.55 + 0.35 * (((k * 7) % 5) / 4) // varied chromosome sizes
    const group = new THREE.Group()
    const bodyMats: THREE.MeshStandardMaterial[] = []
    for (const dx of [-0.075, 0.075]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.55, metalness: 0.05 })
      bodyMats.push(mat)
      const chromatid = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, half * 2, 6, 12), mat)
      chromatid.position.x = dx
      group.add(chromatid)
    }
    const centromere = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.6 }),
    )
    centromere.scale.set(1.15, 0.7, 1.15)
    group.add(centromere)
    const caps: THREE.Mesh[] = []
    for (const sign of [1, -1]) {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.115, 0.115, 1, 20),
        new THREE.MeshStandardMaterial({ color: 0x0d9488, roughness: 0.35, emissive: 0x000000 }),
      )
      cap.userData.sign = sign
      group.add(cap)
      caps.push(cap)
    }
    const a = (k / nChrom) * Math.PI * 2
    group.position.set(Math.cos(a) * RING_RADIUS, 0, Math.sin(a) * RING_RADIUS)
    group.rotation.y = -a
    group.rotation.z = ((k % 3) - 1) * 0.12
    ring.add(group)
    chromosomes.push({ group, bodyMats, caps, half })
  }
  const bridges = new THREE.Group()
  ring.add(bridges)

  const state: SceneState = {
    scene, chromosomes, bridges, renderer, controls, camera, frameStage: 'normal', time: 0,
    dispose: () => {
      controls.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose?.()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat?.dispose?.()
      })
      renderer.dispose()
    },
  }
  return state
}

function applyFrame(s: SceneState, run: SimulationRun, index: number) {
  const f = cellFrameAt(run, index)
  s.frameStage = f.stage
  const gray = f.stage === 'senescent' || f.stage === 'extinct'
  s.chromosomes.forEach((c, k) => {
    c.bodyMats.forEach((m) => m.color.set(gray ? 0x94a3b8 : 0x64748b))
    c.caps.forEach((cap, e) => {
      const len = f.lengths[2 * k + e] ?? f.mean
      const h = Math.max(0.03, (len / f.initialLength) * CAP_MAX)
      const sign = cap.userData.sign as number
      cap.scale.set(1, h, 1)
      cap.position.y = sign * (c.half + 0.06 + h / 2 + 0.02)
      const [r, g, b] = telomereColor(len, f.threshold)
      const mat = cap.material as THREE.MeshStandardMaterial
      mat.color.setRGB(r, g, b)
      cap.userData.critical = f.critical[2 * k + e]
    })
  })
  // Fusion bridges between neighbouring chromosomes' short ends (senescent stage only).
  while (s.bridges.children.length) {
    const ch = s.bridges.children.pop() as THREE.Mesh
    ch.geometry.dispose()
    ;(ch.material as THREE.Material).dispose()
  }
  s.bridges.visible = f.stage === 'senescent'
  if (f.stage === 'senescent') {
    const n = s.chromosomes.length
    for (let k = 0; k < n; k++) {
      const next = (k + 1) % n
      for (const [e, sign] of [[0, 1], [1, -1]] as const) {
        if (!f.critical[2 * k + e] || !f.critical[2 * next + e]) continue
        const a = s.chromosomes[k].group.position.clone().add(new THREE.Vector3(0, sign * (s.chromosomes[k].half + 0.15), 0))
        const b = s.chromosomes[next].group.position.clone().add(new THREE.Vector3(0, sign * (s.chromosomes[next].half + 0.15), 0))
        const mid = a.clone().add(b).multiplyScalar(0.5).multiplyScalar(0.82)
        mid.y = a.y + sign * 0.25
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
        s.bridges.add(new THREE.Mesh(
          new THREE.TubeGeometry(curve, 16, 0.035, 6, false),
          new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 }),
        ))
      }
    }
  }
}

export interface TelomereCell3DProps {
  run: SimulationRun
  dark?: boolean
  /** Reports the displayed cycle so the page can sync a chart cursor. */
  onCycleChange?: (cycle: number) => void
}

export default function TelomereCell3D({ run, dark = false, onCycleChange }: TelomereCell3DProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<SceneState | null>(null)
  const runRef = useRef(run)
  const total = run.timeseries.cycle.length
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [supported] = useState(webglAvailable)
  const [shownRun, setShownRun] = useState(run)
  if (run !== shownRun) {
    setShownRun(run)
    setIndex(0)
    setPlaying(false)
  }

  const nChrom = chromosomeCount(run)
  // Scene lifecycle (rebuilt when the theme or chromosome count changes).
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !supported) return
    const s = buildScene(canvas, nChrom, dark)
    stateRef.current = s
    const resize = () => {
      const w = wrap.clientWidth
      const h = Math.max(280, Math.min(460, Math.round(w * 0.6)))
      s.renderer.setSize(w, h, false)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      s.camera.aspect = w / h
      s.camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      s.time += dt
      const pulse = 0.5 + 0.5 * Math.sin(s.time * 5)
      for (const c of s.chromosomes) {
        for (const cap of c.caps) {
          const mat = cap.material as THREE.MeshStandardMaterial
          mat.emissive.setRGB(cap.userData.critical ? 0.55 * pulse : 0, 0, 0)
        }
      }
      s.controls.update()
      s.renderer.render(s.scene, s.camera)
      raf = requestAnimationFrame(tick)
    }
    applyFrame(s, runRef.current, 0)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      s.dispose()
      stateRef.current = null
    }
  }, [nChrom, dark, supported])

  // Push the current frame into the scene (also after a scene rebuild).
  useEffect(() => {
    runRef.current = run
    if (stateRef.current) applyFrame(stateRef.current, run, index)
    onCycleChange?.(run.timeseries.cycle[Math.min(index, total - 1)] ?? 0)
  }, [run, index, total, nChrom, dark, supported, onCycleChange])

  // Playback: ~10 cycles/s.
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setIndex((i) => {
        if (i >= total - 1) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, 100)
    return () => window.clearInterval(id)
  }, [playing, total])

  if (!supported) {
    return (
      <p className="prose-muted text-sm" role="status">
        3D view unavailable: this browser has no WebGL.
      </p>
    )
  }

  const frame = cellFrameAt(run, index)
  const jump = (stage: CellStage) => {
    setPlaying(false)
    setIndex(stage === 'senescent' ? lastLiveFrame(run) : firstFrameAtStage(run, stage))
  }
  const kb = (bp: number) => `${(bp / 1000).toFixed(2)} kb`

  return (
    <section className="space-y-3" aria-label="3D telomere cell view" data-testid="telomere-3d">
      <div ref={wrapRef} className="card relative overflow-hidden p-0">
        <canvas ref={canvasRef} className="block w-full touch-none" aria-label="3D chromosomes with telomere caps" />
        <span className={`absolute left-3 top-3 rounded-full px-3 py-1 text-xs font-semibold ${STAGE_TONE[frame.stage]}`}>
          {STAGE_LABEL[frame.stage]}
        </span>
        <dl className="absolute right-3 top-3 grid grid-cols-[auto_auto] gap-x-3 rounded-lg bg-white/80 px-3 py-2 text-xs shadow-sm backdrop-blur dark:bg-slate-900/70">
          <dt className="text-slate-500">cycle</dt>
          <dd className="text-right font-mono">{frame.cycle}</dd>
          <dt className="text-slate-500">mean telomere</dt>
          <dd className="text-right font-mono">{kb(frame.mean)}</dd>
          <dt className="text-slate-500">shortest</dt>
          <dd className="text-right font-mono">{kb(frame.shortest)}</dd>
          <dt className="text-slate-500">senescence limit</dt>
          <dd className="text-right font-mono">{kb(frame.threshold)}</dd>
        </dl>
        <ul className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-white/80 px-3 py-1.5 text-[11px] backdrop-blur dark:bg-slate-900/70">
          <li><span className="mr-1 inline-block h-2 w-2 rounded-full bg-teal-600" />long</li>
          <li><span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />eroding</li>
          <li><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-600" />below limit</li>
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-ghost !px-3 !py-1 !text-xs" onClick={() => setPlaying((p) => !p)} disabled={total < 2}>
          {playing ? 'Pause' : 'Play divisions'}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={index}
          onChange={(e) => {
            setPlaying(false)
            setIndex(Number(e.target.value))
          }}
          className="min-w-40 flex-1 accent-teal-600"
          aria-label="Cell cycle"
        />
        {(['normal', 'eroding', 'critical', 'senescent'] as const).map((st) => (
          <button key={st} type="button" className="btn-ghost !px-2 !py-1 !text-xs" onClick={() => jump(st)}>
            {st === 'senescent' ? 'depleted' : st}
          </button>
        ))}
      </div>
      <p className="prose-muted text-xs">
        Illustration of the population's typical cell, reconstructed from the run's per-cycle summary statistics
        (telomere lengths spread evenly around the mean, shortest end = mean shortest-per-cell). Chromosome shapes are
        stylised and the count follows the model's <code>telomeres_per_cell</code>; not a measured single cell and not
        real chromosome structure. Drag to rotate.
      </p>
    </section>
  )
}
