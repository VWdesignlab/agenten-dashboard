/** Was ein Agent gerade tut. Aktiv sind denkt, arbeitet, delegiert. */
export type AgentPhase = 'denkt' | 'arbeitet' | 'delegiert' | 'wartet' | 'fertig' | 'fehler' | 'abgebrochen'

/** Ein Werkzeugaufruf, der gerade läuft. */
export type RunningCall = {
  id: string
  tool: string
  label: string
  since: number
  /** Worauf der Aufruf wartet: '' = nichts, 'frage' = Frage an dich, 'freigabe' = Freigabe angefragt. */
  wait: '' | 'frage' | 'freigabe'
}

export type AgentRow = {
  id: string
  /** Kurzname: Hauptagent oder die description des Subagenten. */
  name: string
  /** Der Auftrag in einem Satz: beim Hauptagenten deine Anfrage, beim Subagenten sein Prompt. */
  task: string
  kind: string
  model: string
  /** Aufwand (effort) des letzten Modellaufrufs; leer, wenn das Modell keinen kennt. */
  effort: string
  /** Was der Gatekeeper entschieden hat; leer, wenn er nichts entschieden hat. */
  route: string
  parentId: string
  phase: AgentPhase
  /** Seit wann die aktuelle Phase läuft (ms). */
  phaseSince: number
  running: RunningCall[]
  /** Der zuletzt abgeschlossene Schritt. */
  last: string
  tools: number
  /** Modellaufrufe (Denkschritte). */
  steps: number
  errors: number
  startedAt: number
  endedAt: number
  /** Letztes Ereignis dieses Agenten, für die Erkennung von Stillstand. */
  lastEventAt: number
  /** Zählt die Durchgänge; spät eintreffende Ereignisse eines alten Durchgangs werden daran erkannt. */
  turn: number
}

export type LogRow = { at: number; agentId: string; text: string; isError: boolean }

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanTask = {
  id: string
  subject: string
  doneWhen: string
  status: PlanStatus
  owner: string
  blockedBy: string[]
}

export type GatekeeperMode = 'aus' | 'normal' | 'qualitaet'

export type DashboardSettings = {
  gatekeeper: GatekeeperMode
  planer: boolean
}

export type Stats = {
  /** Wie viele Subagenten in dieser Sitzung auf ein kleineres Modell gelegt wurden. */
  routedDown: number
  /** Wie viele Subagenten der Gatekeeper geprüft hat. */
  checked: number
}

declare module 'claude-code' {
  interface PluginState {
    'agenten-dashboard': {
      agents: Shaped<AgentRow[]>
      log: Shaped<LogRow[]>
      plan: Shaped<PlanTask[]>
      settings: Shaped<DashboardSettings>
      stats: Shaped<Stats>
    }
  }
}
