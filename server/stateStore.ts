import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type PersistedMeteoraState = {
  launches?: unknown[]
  creatorFeeClaims?: unknown[]
  bundles?: unknown[]
}

type MeteorasConsoleDatabase = {
  public: {
    Tables: {
      meteoras_console_state: {
        Row: {
          id: string
          state: PersistedMeteoraState
          updated_at: string
        }
        Insert: {
          id: string
          state: PersistedMeteoraState
          updated_at?: string
        }
        Update: {
          state?: PersistedMeteoraState
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

type MeteorasSupabaseClient = SupabaseClient<MeteorasConsoleDatabase>

export async function loadPersistedState(): Promise<PersistedMeteoraState> {
  const supabase = createSupabaseStateClient()
  if (supabase) {
    return loadSupabaseState(supabase)
  }

  return loadFileState()
}

export async function savePersistedState(state: PersistedMeteoraState): Promise<void> {
  const supabase = createSupabaseStateClient()
  if (supabase) {
    await saveSupabaseState(supabase, state)
    return
  }

  await saveFileState(state)
}

// Merge top-level keys into the persisted state instead of overwriting the whole
// object. The launch/fee module and the bundler module each own different keys
// (launches/creatorFeeClaims vs bundles); a full overwrite from one would wipe
// the other's data. Always merge so independent owners coexist.
export async function persistPartialState(partial: PersistedMeteoraState): Promise<void> {
  const current = await loadPersistedState()
  await savePersistedState({ ...current, ...partial })
}

async function loadSupabaseState(supabase: MeteorasSupabaseClient): Promise<PersistedMeteoraState> {
  const { data, error } = await supabase
    .from(getSupabaseStateTable())
    .select('state')
    .eq('id', getSupabaseStateRowId())
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load Supabase state: ${error.message}`)
  }

  return isRecord(data?.state) ? data.state : {}
}

async function saveSupabaseState(supabase: MeteorasSupabaseClient, state: PersistedMeteoraState): Promise<void> {
  const { error } = await supabase
    .from(getSupabaseStateTable())
    .upsert({
      id: getSupabaseStateRowId(),
      state,
      updated_at: new Date().toISOString(),
    })

  if (error) {
    throw new Error(`Failed to save Supabase state: ${error.message}`)
  }
}

async function loadFileState(): Promise<PersistedMeteoraState> {
  try {
    const text = await readFile(getStatePath(), 'utf8')
    const state = JSON.parse(text)
    return isRecord(state) ? state : {}
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      console.warn('[meteoras-console-api] failed to load state file', error)
    }
    return {}
  }
}

async function saveFileState(state: PersistedMeteoraState): Promise<void> {
  const statePath = getStatePath()
  await mkdir(dirname(statePath), { recursive: true })
  const tempPath = `${statePath}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify(state, null, 2))
  await rename(tempPath, statePath)
}

function createSupabaseStateClient(): MeteorasSupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) return null

  return createClient<MeteorasConsoleDatabase>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

function getSupabaseStateTable(): 'meteoras_console_state' {
  const table = process.env.SUPABASE_STATE_TABLE ?? 'meteoras_console_state'
  if (table !== 'meteoras_console_state') {
    throw new Error('SUPABASE_STATE_TABLE must be meteoras_console_state.')
  }

  return table
}

function getSupabaseStateRowId(): string {
  return process.env.SUPABASE_STATE_ROW_ID ?? 'default'
}

function getStatePath(): string {
  return resolve(process.cwd(), process.env.DATA_DIR ?? '.data', 'meteoras-console-state.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error)
}
