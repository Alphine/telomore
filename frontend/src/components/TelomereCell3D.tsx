// 3D "representative cell" view: sister-chromatid chromosomes (G-band texture,
// clear-coat shading) with glowing telomere caps whose length and colour follow
// the simulation's per-cycle statistics (see telomereCell.ts for how the cell is
// reconstructed -- an illustration of the population's typical cell, not a
// measured single cell). Rendered on a fixed dark "microscope field" so it reads
// the same in light and dark themes. Default export so Simulate can React.lazy()
// it: three.js only downloads when the view is opened.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import type { SimulationRun } from '../api/types'
import { STAGE_LABEL, cellFrameAt, chromosomeCount, firstFrameAtStage, lastLiveFrame, telomereColor } from './telomereCell'
import type { CellStage } from './telomereCell'

const RING_RADIUS = 2.5
const CAP_MAX = 0.6 // world-units length of a cap at initial telomere length
const CAP_BASE = 0.376 // unscaled height of the cap capsule (radius 0.088, length 0.2)
const FIELD_BG = 'radial-gradient(ellipse at 50% 42%, #23375c 0%, #111d35 55%, #070d19 100%)'
const STAGE_TONE: Record<CellStage, string> = {
  normal: 'bg-emerald-100 text-emerald-900',
  eroding: 'bg-amber-100 text-amber-900',
  critical: 'bg-orange-100 text-orange-900',
  senescent: 'bg-red-100 text-red-900',
  extinct: 'bg-slate-200 text-slate-800',
}
const STAGE_DOT: Record<CellStage, string> = {
  normal: 'bg-teal-600',
  eroding: 'bg-amber-500',
  critical: 'bg-orange-500',
  senescent: 'bg-red-600',
  extinct: 'bg-slate-500',
}

interface Chromosome {
  group: THREE.Group
  bodyMats: THREE.MeshPhysicalMaterial[]
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

/** Vertical G-band stripes (dark/light bands along the chromatid), deterministic. */
function bandTexture(): THREE.CanvasTexture {
  const w = 32
  const h = 256
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#e3e9f1'
  ctx.fillRect(0, 0, w, h)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  let y = 0
  while (y < h) {
    const bh = 4 + rnd() * 12
    if (rnd() < 0.5) {
      ctx.fillStyle = `rgba(29, 42, 64, ${0.16 + rnd() * 0.2})`
      ctx.fillRect(0, y, w, bh)
    }
    y += bh + 3 + rnd() * 6
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

function buildScene(canvas: HTMLCanvasElement, nChrom: number): SceneState {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.toneMapping = THREE.NeutralToneMapping // keeps cap hues saturated (ACES washes them out)
  renderer.toneMappingExposure = 1
  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x0a1222, 7.5, 15) // far chromosomes fade into the field: depth cue

  const pmrem = new THREE.PMREMGenerator(renderer)
  const envScene = new RoomEnvironment()
  scene.environment = pmrem.fromScene(envScene, 0.04).texture
  envScene.dispose()
  pmrem.dispose()

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(0, 1.4, 8.6)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.enablePan = false
  controls.minDistance = 4
  controls.maxDistance = 13
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.8

  const key = new THREE.DirectionalLight(0xffffff, 1.8)
  key.position.set(4, 6, 5)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x6fa0ff, 1.2)
  rim.position.set(-5, 2, -6)
  scene.add(rim)

  // Nucleus envelope: faint translucent shell + wire lattice.
  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(3.7, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x5b8fe0, transparent: true, opacity: 0.06, side: THREE.BackSide, depthWrite: false }),
    ),
  )
  scene.add(
    new THREE.Mesh(
      new THREE.IcosahedronGeometry(3.72, 2),
      new THREE.MeshBasicMaterial({ color: 0x7ea2d8, wireframe: true, transparent: true, opacity: 0.1, fog: false }),
    ),
  )

  const bands = bandTexture()
  const chromosomes: Chromosome[] = []
  const ring = new THREE.Group()
  scene.add(ring)
  for (let k = 0; k < nChrom; k++) {
    const half = 0.55 + 0.35 * (((k * 7) % 5) / 4) // varied chromosome sizes
    const group = new THREE.Group()
    const bodyMats: THREE.MeshPhysicalMaterial[] = []
    for (const sign of [-1, 1]) {
      const mat = new THREE.MeshPhysicalMaterial({
        color: 0xdfe6ef,
        map: bands,
        roughness: 0.42,
        metalness: 0.02,
        clearcoat: 0.7,
        clearcoatRoughness: 0.3,
      })
      bodyMats.push(mat)
      const chromatid = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, half * 2, 8, 20), mat)
      chromatid.rotation.z = sign * 0.11 // X-shaped sister chromatids meeting at the centromere
      group.add(chromatid)
    }
    const centromere = new THREE.Mesh(
      new THREE.SphereGeometry(0.115, 20, 14),
      new THREE.MeshPhysicalMaterial({ color: 0x5a6a82, roughness: 0.55, clearcoat: 0.3 }),
    )
    centromere.scale.set(1.2, 0.72, 1.2)
    group.add(centromere)
    const caps: THREE.Mesh[] = []
    for (const sign of [1, -1]) {
      const cap = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.088, 0.2, 8, 20),
        new THREE.MeshPhysicalMaterial({ color: 0x2fc4b8, emissive: 0x2fc4b8, emissiveIntensity: 0.4, roughness: 0.35, clearcoat: 0.5 }),
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

  return {
    scene, chromosomes, bridges, renderer, controls, camera, time: 0,
    dispose: () => {
      controls.dispose()
      bands.dispose()
      scene.environment?.dispose()
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
}

function applyFrame(s: SceneState, run: SimulationRun, index: number) {
  const f = cellFrameAt(run, index)
  const gray = f.stage === 'senescent' || f.stage === 'extinct'
  s.chromosomes.forEach((c, k) => {
    c.bodyMats.forEach((m) => m.color.set(gray ? 0x9aa6b8 : 0xdfe6ef))
    c.caps.forEach((cap, e) => {
      const len = f.lengths[2 * k + e] ?? f.mean
      const capLen = Math.max(0.05, (len / f.initialLength) * CAP_MAX)
      const sign = cap.userData.sign as number
      cap.scale.set(1, capLen / CAP_BASE, 1)
      cap.position.y = sign * (c.half + 0.075 + capLen / 2)
      const [r, g, b] = telomereColor(len, f.threshold)
      const mat = cap.material as THREE.MeshPhysicalMaterial
      mat.color.setRGB(r, g, b, THREE.SRGBColorSpace)
      mat.emissive.setRGB(r, g, b, THREE.SRGBColorSpace)
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
          new THREE.TubeGeometry(curve, 16, 0.04, 8, false),
          new THREE.MeshPhysicalMaterial({ color: 0xe0564b, emissive: 0xe0564b, emissiveIntensity: 0.35, roughness: 0.4, clearcoat: 0.8 }),
        ))
      }
    }
  }
}

export interface TelomereCell3DProps {
  run: SimulationRun
  /** Kept for API symmetry with the other visual components; the specimen field is always dark. */
  dark?: boolean
  /** Reports the displayed cycle so the page can sync a chart cursor. */
  onCycleChange?: (cycle: number) => void
}

export default function TelomereCell3D({ run, onCycleChange }: TelomereCell3DProps) {
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
  // Scene lifecycle (rebuilt when the chromosome count changes).
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !supported) return
    const s = buildScene(canvas, nChrom)
    stateRef.current = s
    const resize = () => {
      const w = wrap.clientWidth
      const h = Math.max(300, Math.min(480, Math.round(w * 0.5)))
      s.renderer.setSize(w, h, false)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      wrap.style.height = `${h}px`
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
          const mat = cap.material as THREE.MeshPhysicalMaterial
          mat.emissiveIntensity = cap.userData.critical ? 0.4 + 0.9 * pulse : 0.4
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
  }, [nChrom, supported])

  // Push the current frame into the scene (also after a scene rebuild).
  useEffect(() => {
    runRef.current = run
    if (stateRef.current) applyFrame(stateRef.current, run, index)
    onCycleChange?.(run.timeseries.cycle[Math.min(index, total - 1)] ?? 0)
  }, [run, index, total, nChrom, supported, onCycleChange])

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
  const glass = 'rounded-lg border border-white/15 bg-slate-950/70 text-slate-300 backdrop-blur'

  return (
    <section className="space-y-0" aria-label="3D telomere cell view" data-testid="telomere-3d">
      <div className="card overflow-hidden p-0">
        <div ref={wrapRef} className="relative" style={{ background: FIELD_BG, minHeight: 300 }}>
          <canvas ref={canvasRef} className="block w-full touch-none" aria-label="3D chromosomes with telomere caps" />
          <span className={`absolute left-3 top-3 flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${STAGE_TONE[frame.stage]}`}>
            <span className={`h-2 w-2 rounded-full ${STAGE_DOT[frame.stage]}`} />
            {STAGE_LABEL[frame.stage]}
          </span>
          <dl className={`absolute right-3 top-3 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 px-3 py-2 text-xs ${glass}`}>
            <dt>cycle</dt>
            <dd className="text-right font-mono text-white">{frame.cycle}</dd>
            <dt>mean telomere</dt>
            <dd className="text-right font-mono text-white">{kb(frame.mean)}</dd>
            <dt>shortest</dt>
            <dd className="text-right font-mono text-white">{kb(frame.shortest)}</dd>
            <dt>senescence limit</dt>
            <dd className="text-right font-mono text-red-300">{kb(frame.threshold)}</dd>
          </dl>
          <ul className={`absolute bottom-3 left-3 flex flex-wrap gap-x-4 gap-y-1 px-3 py-1.5 text-[11px] ${glass}`}>
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-teal-500" />long</li>
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-amber-500" />eroding</li>
            <li><span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-red-500" />below limit</li>
          </ul>
          <span className="absolute bottom-3 right-3 font-mono text-[11px] text-slate-400">drag to rotate · illustrative scale</span>
        </div>

        <div className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-center gap-4">
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
              onClick={() => setPlaying((p) => !p)}
              disabled={total < 2}
              aria-label={playing ? 'Pause' : 'Play divisions'}
            >
              {playing ? (
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
                  <rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
                </svg>
              )}
            </button>
            <div className="min-w-0 flex-1 space-y-1">
              <div
                className="h-2.5 rounded-full"
                style={{ background: 'linear-gradient(90deg, #1fa89c 0%, #1fa89c 18%, #e9a92f 45%, #e0812f 70%, #cc3a30 100%)' }}
                aria-hidden="true"
              />
              <input
                type="range"
                min={0}
                max={Math.max(0, total - 1)}
                value={index}
                onChange={(e) => {
                  setPlaying(false)
                  setIndex(Number(e.target.value))
                }}
                className="block w-full accent-teal-600"
                aria-label="Cell cycle"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Jump to stage">
            {(['normal', 'eroding', 'critical', 'senescent'] as const).map((st) => (
              <button
                key={st}
                type="button"
                aria-pressed={frame.stage === st}
                className={`rounded-full border px-4 py-1.5 text-xs font-medium ${
                  frame.stage === st
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                    : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
                }`}
                onClick={() => jump(st)}
              >
                {st === 'senescent' ? 'depleted' : st}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="prose-muted pt-3 text-xs">
        Illustration of the population's typical cell, reconstructed from the run's per-cycle summary statistics
        (telomere lengths spread evenly around the mean, shortest end = mean shortest-per-cell). Chromosome shapes are
        stylised and the count follows the model's <code>telomeres_per_cell</code>; not a measured single cell and not
        real chromosome structure. Drag to rotate.
      </p>
    </section>
  )
}
