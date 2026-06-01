import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { t as translate } from './locales'

// Codex pet protocol constants
const CELL_WIDTH = 192
const CELL_HEIGHT = 208
const ATLAS_WIDTH = 1536
const ATLAS_HEIGHT = 1872
const MIN_WINDOW_WIDTH = 240
const BUBBLE_SPACE_HEIGHT = 92
const CODEX_ORIGINAL_SCALE = 0.45
const DEFAULT_PET_SCALE = CODEX_ORIGINAL_SCALE
const PET_SCALE_OPTIONS = [
  { labelKey: 'sizeSmall', value: CODEX_ORIGINAL_SCALE * 0.75, percent: 75 },
  { labelKey: 'sizeOriginal', value: CODEX_ORIGINAL_SCALE, percent: 100 },
  { labelKey: 'sizeLarge', value: CODEX_ORIGINAL_SCALE * 1.25, percent: 125 },
  { labelKey: 'sizeXl', value: CODEX_ORIGINAL_SCALE * 1.5, percent: 150 },
]
const LIVE_SOURCES = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude', label: 'Claude Code' },
  { key: 'opencode', label: 'opencode' },
  { key: 'openclaw', label: 'OpenClaw' },
  { key: 'hermes', label: 'Hermes Agent' },
]
const EMPTY_LIVE_SOURCE_STATUS = {
  enabled: true,
  path: '',
  defaultPath: '',
  focusTarget: '',
  defaultFocusTarget: '',
}
const STATE_ROWS = {
  idle: 0,
  'running-right': 1,
  'running-left': 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
}

const FRAME_COUNTS = {
  idle: 6,
  'running-right': 8,
  'running-left': 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
}

const getSpritesheetSource = (petConfig) => {
  return petConfig?.spritesheetDataUrl || petConfig?.spritesheet_data_url || ''
}

function App() {
  const [currentState, setCurrentState] = useState('idle')
  const [currentFrame, setCurrentFrame] = useState(0)
  const [spritesheet, setSpritesheet] = useState('')
  const [isSettings, setIsSettings] = useState(false)
  const [windowIdentity, setWindowIdentity] = useState('unknown')
  const [debugLogs, setDebugLogs] = useState([])
  const [showDebug, setShowDebug] = useState(false)
  const [isChat, setIsChat] = useState(false)
  const [debugHiddenByUser, setDebugHiddenByUser] = useState(false)
  const [pets, setPets] = useState([])
  const [messageMap, setMessageMap] = useState({})
  const [wsStatus, setWsStatus] = useState({ enabled: true, port: 8765 })
  const [liveSourcesStatus, setLiveSourcesStatus] = useState({
    codex: { ...EMPTY_LIVE_SOURCE_STATUS },
    claude: { ...EMPTY_LIVE_SOURCE_STATUS },
    opencode: { ...EMPTY_LIVE_SOURCE_STATUS },
    openclaw: { ...EMPTY_LIVE_SOURCE_STATUS },
    hermes: { ...EMPTY_LIVE_SOURCE_STATUS },
  })
  const [liveSourcePrefixEnabled, setLiveSourcePrefixEnabled] = useState(false)
  const [petScale, setPetScale] = useState(DEFAULT_PET_SCALE)
  const [bubble, setBubble] = useState(null)
  const [userPetDir, setUserPetDir] = useState('')
  const [locale, setLocale] = useState('en')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatHistory, setChatHistory] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [inputPulse, setInputPulse] = useState(false)
  const [windowFocused, setWindowFocused] = useState(true)
  const [chatError, setChatError] = useState('')
  const chatMessagesRef = useRef(null)
  const pointerDownRef = useRef(null)
  const canvasRef = useRef(null)

  
  // Particle background animation for chat window
  useEffect(() => {
    if (!isChat || !canvasRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    let animationId = null
    let particles = []

    const resize = () => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    }
    resize()
    window.addEventListener('resize', resize)

    // Create particles
    const particleCount = 60
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 3 + 1,
        speedY: -(Math.random() * 0.3 + 0.1),
        speedX: (Math.random() - 0.5) * 0.2,
        opacity: Math.random() * 0.4 + 0.1,
        fadeSpeed: Math.random() * 0.005 + 0.002,
      })
    }

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      particles.forEach((p) => {
        p.y += p.speedY
        p.x += p.speedX
        p.opacity += Math.sin(Date.now() * p.fadeSpeed) * 0.01

        if (p.y < -10) {
          p.y = canvas.height + 10
          p.x = Math.random() * canvas.width
        }
        if (p.x < -10) p.x = canvas.width + 10
        if (p.x > canvas.width + 10) p.x = -10

        p.opacity = Math.max(0.05, Math.min(0.5, p.opacity))

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(123, 97, 255, ${p.opacity})`
        ctx.fill()
      })

      animationId = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('resize', resize)
    }
  }, [isChat])

  // Load conversations from SQLite when chat window initializes
  useEffect(() => {
    if (!isChat) return
    const loadConversations = async () => {
      try {
        const convs = await invoke('get_conversations')
        setChatHistory(convs.map(c => ({ id: c.id, title: c.title, preview: c.title })))
      } catch (e) {
        console.error('Failed to load conversations:', e)
      }
    }
    loadConversations()
  }, [isChat])

  // Search conversations with debounce
  useEffect(() => {
    if (!isChat) return
    const timer = setTimeout(async () => {
      try {
        let convs
        if (searchQuery.trim()) {
          convs = await invoke('search_conversations', { keyword: searchQuery })
        } else {
          convs = await invoke('get_conversations')
        }
        setChatHistory(convs.map(c => ({ id: c.id, title: c.title, preview: c.title })))
      } catch (e) {
        console.error('Failed to search conversations:', e)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, isChat])

  const t = (key, params) => translate(locale, key, params)
  
  const animRef = useRef(null)
  const bubbleTimerRef = useRef(null)
  const lastTimeRef = useRef(0)
  const frameRef = useRef(0)
  const stateRef = useRef('idle')
  const stateStartRef = useRef(Date.now())
  const lastClickRef = useRef(0)
  const displayWidth = CELL_WIDTH * petScale
  const displayHeight = CELL_HEIGHT * petScale
  const windowWidth = Math.max(displayWidth, MIN_WINDOW_WIDTH)
  const windowHeight = displayHeight + BUBBLE_SPACE_HEIGHT

  // Determine if this is the settings window
  useEffect(() => {
    const onKeyDown = (e) => {
      try {
        if (e.key === 'd') {
          setDebugHiddenByUser((prev) => !prev)
        }
      } catch (_) {}
    }
    window.addEventListener('keydown', onKeyDown)

    const init = async () => {
      try {
        const webview = getCurrentWebviewWindow()
        const currentWindow = getCurrentWindow()
        const webviewLabel = webview?.label || 'unknown-webview'
        const windowLabel = currentWindow?.label || 'unknown-window'

        let label = windowLabel
        try {
          const meta = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__?.metadata : null
          if (meta?.currentWindow?.label) {
            label = meta.currentWindow.label
          } else if (meta?.currentWebview?.label) {
            label = meta.currentWebview.label
          }
        } catch (_) {
          // ignore metadata probe failure
        }
        if (!label || label === 'unknown-window') {
          label = webviewLabel
        }

        const isChatWindow = label === 'chat'
        const isSettingsWindow = label === 'settings'

        const identity = isChatWindow ? 'chat' : isSettingsWindow ? 'settings' : label === 'pet' ? 'pet' : 'unknown'
        setWindowIdentity(identity)
        setIsSettings(isSettingsWindow)
        setIsChat(isChatWindow)

        console.debug('[DEBUG PROBE 21] init identity', {
          webviewLabel,
          windowLabel,
          resolvedLabel: label,
          identity,
          isSettingsWindow,
          isChatWindow,
        })
        console.warn('[DEBUG PROBE 21] init identity', {
          webviewLabel,
          windowLabel,
          resolvedLabel: label,
          identity,
          isSettingsWindow,
          isChatWindow,
        })

        if (isChatWindow) {
          loadLanguage()
        } else if (identity === 'pet') {
          await loadLanguage()
          await loadPetScale()
          await loadPetList()
          await loadInitialPet()
        } else if (isSettingsWindow) {
          loadPetScale()
          loadPetList()
          loadMessageMap()
          loadWsStatus()
          loadLiveSourcesStatus()
          loadLiveSourcePrefixEnabled()
          loadUserPetDir()
          loadLanguage()
          loadApiKey()
          currentWindow.onCloseRequested(async (e) => {
            try {
              e.preventDefault()
              await currentWindow.hide()
            } catch (err) {
              console.error('Failed to hide settings window:', err)
            }
          })
        } else {
          await loadLanguage()
          await loadPetScale()
          await loadPetList()
          await loadInitialPet()
        }
      } catch (err) {
        console.error('[DEBUG PROBE 22] init failed', err)
        setWindowIdentity('unknown')
        setIsSettings(false)
        setIsChat(false)
        await loadLanguage()
        await loadPetScale()
        await loadPetList()
        await loadInitialPet()
      }
    }
    init()

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // Listen for state changes from backend
  useEffect(() => {
    const unlistenState = listen('state-changed', (event) => {
      const newState = event.payload
      stateRef.current = newState
      setCurrentState(newState)
      frameRef.current = 0
      setCurrentFrame(0)
      stateStartRef.current = Date.now()
    })

    // Listen for pet-loaded events (e.g. from settings window switching pets)
    const unlistenPetLoaded = listen('pet-loaded', (event) => {
      const config = event.payload
      const source = getSpritesheetSource(config)
      if (source) {
        setSpritesheet(source)
      }
    })

    const unlistenReloadPet = listen('reload-pet', async () => {
      try {
        console.debug('[DEBUG PROBE 25] reload-pet start')
        setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] reload-pet start`])
        await loadPetList()
        await loadInitialPet()
        console.debug('[DEBUG PROBE 26] reload-pet finished')
        setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] reload-pet finished`])
      } catch (e) {
        console.error('Failed to reload pet:', e)
        setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] reload-pet error: ${String(e)}`])
      }
    })

    const unlistenScaleChanged = listen('pet-scale-changed', (event) => {
      setPetScale(event.payload || DEFAULT_PET_SCALE)
    })

    const unlistenCodexBubble = listen('codex-bubble', (event) => {
      const text = event.payload?.text
      if (!text) return

      setBubble({
        text,
        source: event.payload?.source || '',
        sourceLabel: event.payload?.sourceLabel || '',
      })
      if (bubbleTimerRef.current) {
        clearTimeout(bubbleTimerRef.current)
      }
      bubbleTimerRef.current = setTimeout(() => {
        setBubble(null)
        bubbleTimerRef.current = null
      }, 4200)
    })

    return () => {
      unlistenState.then(f => f())
      unlistenPetLoaded.then(f => f())
      unlistenScaleChanged.then(f => f())
      unlistenCodexBubble.then(f => f())
      unlistenReloadPet.then(f => f())
      if (bubbleTimerRef.current) {
        clearTimeout(bubbleTimerRef.current)
      }
    }
  }, [])



  // Animation loop
  useEffect(() => {
    if (isSettings || !spritesheet) return

    const animate = (timestamp) => {
      const durations = getStateDurations(stateRef.current)
      const frameCount = FRAME_COUNTS[stateRef.current] || 6
      
      if (durations.length > 0) {
        const elapsed = timestamp - lastTimeRef.current
        const currentDuration = durations[frameRef.current % durations.length]
        
        if (elapsed >= currentDuration) {
          frameRef.current = (frameRef.current + 1) % frameCount
          setCurrentFrame(frameRef.current)
          lastTimeRef.current = timestamp
        }
      }

      // Auto-return to idle after state duration
      const stateDuration = getStateDuration(stateRef.current)
      if (Date.now() - stateStartRef.current >= stateDuration) {
        if (stateRef.current !== 'idle') {
          stateRef.current = 'idle'
          setCurrentState('idle')
          frameRef.current = 0
          setCurrentFrame(0)
          stateStartRef.current = Date.now()
        }
      }

      animRef.current = requestAnimationFrame(animate)
    }

    animRef.current = requestAnimationFrame(animate)
    return () => {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current)
      }
    }
  }, [spritesheet, isSettings])

  const getStateDurations = (state) => {
    const durations = {
      idle: [280, 110, 110, 140, 140, 320],
      'running-right': [120, 120, 120, 120, 120, 120, 120, 220],
      'running-left': [120, 120, 120, 120, 120, 120, 120, 220],
      waving: [140, 140, 140, 280],
      jumping: [140, 140, 140, 140, 280],
      failed: [140, 140, 140, 140, 140, 140, 140, 240],
      waiting: [150, 150, 150, 150, 150, 260],
      running: [120, 120, 120, 120, 120, 220],
      review: [150, 150, 150, 150, 150, 280],
    }
    return durations[state] || [200]
  }

  const getStateDuration = (state) => {
    const durations = {
      waving: 2000,
      jumping: 2000,
      failed: 3000,
      running: 5000,
      'running-right': 5000,
      'running-left': 5000,
      waiting: 10000,
      review: 5000,
      idle: Infinity,
    }
    return durations[state] || 5000
  }

  const getBackgroundPosition = () => {
    const row = STATE_ROWS[currentState] || 0
    const x = -(currentFrame * displayWidth)
    const y = -(row * displayHeight)
    return `${x}px ${y}px`
  }

  const loadPetScale = async () => {
    try {
      const scale = await invoke('get_pet_scale')
      setPetScale(scale)
    } catch (e) {
      console.error('Failed to load pet scale:', e)
    }
  }

  const loadPetList = async () => {
    try {
      const list = await invoke('get_pet_list')
      setPets(list)
    } catch (e) {
      console.error('Failed to load pets:', e)
    }
  }

  const loadUserPetDir = async () => {
    try {
      const dir = await invoke('get_user_pet_dir')
      setUserPetDir(dir)
    } catch (e) {
      console.error('Failed to load user pet dir:', e)
    }
  }

  const loadInitialPet = async () => {
    try {
    // Small delay to ensure backend is ready
    await new Promise(r => setTimeout(r, 500))
      const savedId = await invoke('get_selected_pet')
      if (savedId) {
        try {
          const pet = await invoke('load_pet', { petId: savedId })
          setSpritesheet(getSpritesheetSource(pet))
          return
        } catch (e) {
          console.warn('Saved pet not found, falling back:', e)
        }
      }


      const list = await invoke('get_pet_list')
      const validPet =
        list.find(p => p.id === 'claude' && p.has_spritesheet) ||
        list.find(p => p.has_spritesheet) ||
        list[0]
      if (validPet) {
        const pet = await invoke('load_pet', { petId: validPet.id })
        setSpritesheet(getSpritesheetSource(pet))
      }
    } catch (e) {
      console.error('Failed to load pet:', e)
    }
  }

  const loadMessageMap = async () => {
    try {
      const map = await invoke('get_message_map')
      setMessageMap(map)
    } catch (e) {
      console.error('Failed to load message map:', e)
    }
  }

  const loadWsStatus = async () => {
    try {
      const status = await invoke('get_websocket_status')
      setWsStatus(status)
    } catch (e) {
      console.error('Failed to load WS status:', e)
    }
  }

  const loadLiveSourcesStatus = async () => {
    try {
      const status = await invoke('get_live_sources_status')
      setLiveSourcesStatus({
        codex: { ...EMPTY_LIVE_SOURCE_STATUS, ...(status.codex || {}) },
        claude: { ...EMPTY_LIVE_SOURCE_STATUS, ...(status.claude || {}) },
        opencode: { ...EMPTY_LIVE_SOURCE_STATUS, ...(status.opencode || {}) },
        openclaw: { ...EMPTY_LIVE_SOURCE_STATUS, ...(status.openclaw || {}) },
        hermes: { ...EMPTY_LIVE_SOURCE_STATUS, ...(status.hermes || {}) },
      })
    } catch (e) {
      console.error('Failed to load live source status:', e)
    }
  }

  const loadLiveSourcePrefixEnabled = async () => {
    try {
      const enabled = await invoke('get_live_source_prefix_enabled')
      setLiveSourcePrefixEnabled(Boolean(enabled))
    } catch (e) {
      console.error('Failed to load live source prefix setting:', e)
    }
  }

  const handleLoadPet = async (petId) => {
    try {
      const pet = await invoke('load_pet', { petId })
      const source = getSpritesheetSource(pet)
      if (source) {
        setSpritesheet(source)
      }
      try { await invoke('save_selected_pet', { petId }) } catch (e) { console.error('Failed to save selected pet:', e) }
      // Backend emits 'pet-loaded' event to the pet window after loading
      loadPetList() // Refresh list to show active
    } catch (e) {
      console.error('Failed to load pet:', e)
    }
  }

  const handleTrigger = async (messageType) => {
    try {
      const newState = await invoke('trigger_state', { messageType })
      stateRef.current = newState
      setCurrentState(newState)
      frameRef.current = 0
      setCurrentFrame(0)
      stateStartRef.current = Date.now()
    } catch (e) {
      console.error('Failed to trigger state:', e)
    }
  }

  const handleUpdateMessageMap = async (key, value) => {
    const newMap = { ...messageMap, [key]: value }
    setMessageMap(newMap)
    try {
      await invoke('update_message_map', { map: newMap })
    } catch (e) {
      console.error('Failed to update message map:', e)
    }
  }

  const handleToggleWs = async () => {
    try {
      await invoke('toggle_websocket', { enabled: !wsStatus.enabled })
      await loadWsStatus()
    } catch (e) {
      console.error('Failed to toggle websocket:', e)
    }
  }

  const handleToggleLiveSource = async (source) => {
    try {
      await invoke('toggle_live_source', {
        source,
        enabled: !liveSourcesStatus[source].enabled,
      })
      await loadLiveSourcesStatus()
    } catch (e) {
      console.error('Failed to toggle live source:', e)
    }
  }

  const handleChangeLiveSourcePath = (source, path) => {
    setLiveSourcesStatus((prev) => ({
      ...prev,
      [source]: {
        ...prev[source],
        path,
      },
    }))
  }

  const handleChangeLiveSourceFocusTarget = (source, focusTarget) => {
    setLiveSourcesStatus((prev) => ({
      ...prev,
      [source]: {
        ...prev[source],
        focusTarget,
      },
    }))
  }

  const handleSaveLiveSourcePath = async (source) => {
    try {
      await invoke('set_live_source_path', {
        source,
        path: liveSourcesStatus[source].path || '',
      })
      await invoke('set_live_source_focus_target', {
        source,
        target: liveSourcesStatus[source].focusTarget || '',
      })
      await loadLiveSourcesStatus()
    } catch (e) {
      console.error('Failed to save live source settings:', e)
    }
  }

  const handleResetLiveSourcePath = async (source) => {
    try {
      await invoke('set_live_source_path', { source, path: '' })
      await invoke('set_live_source_focus_target', { source, target: '' })
      await loadLiveSourcesStatus()
    } catch (e) {
      console.error('Failed to reset live source settings:', e)
    }
  }

  const handleToggleLiveSourcePrefix = async () => {
    try {
      await invoke('set_live_source_prefix_enabled', { enabled: !liveSourcePrefixEnabled })
      await loadLiveSourcePrefixEnabled()
    } catch (e) {
      console.error('Failed to toggle live source prefix:', e)
    }
  }

  const handleSetPetScale = async (scale) => {
    try {
      const appliedScale = await invoke('set_pet_scale', { scale })
      setPetScale(appliedScale)
    } catch (e) {
      console.error('Failed to set pet scale:', e)
    }
  }

  const loadApiKey = async () => {
    try {
      const key = await invoke('get_mimo_api_key')
      setApiKey(key || '')
    } catch (e) {
      console.error('Failed to load API key:', e)
    }
  }

  const handleSaveApiKey = async () => {
    try {
      await invoke('save_mimo_api_key', { apiKey })
    } catch (e) {
      console.error('Failed to save API key:', e)
    }
  }

  const handleTestConnection = async () => {
    try {
      await invoke('test_mimo_connection')
      alert('Connection OK')
    } catch (e) {
      console.error('Connection test failed:', e)
      alert('Connection failed')
    }
  }

  const handleSendChat = async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return

    let convId = activeChatId

    // Create conversation if none exists
    if (!convId) {
      try {
        const title = text.substring(0, 20)
        convId = await invoke('create_conversation', { title })
        setActiveChatId(convId)
      } catch (e) {
        console.error('Failed to create conversation:', e)
        return
      }
    }

    const userMsg = { role: 'user', content: text }
    const nextMessages = [...chatMessages, userMsg]
    setChatMessages(nextMessages)
    setChatInput('')
    setChatLoading(true)
    setChatError('')

    try {
      // Save user message to SQLite
      await invoke('save_message', { conversationId: convId, role: 'user', content: text })

      const response = await invoke('chat_completion', { messages: nextMessages })
      setChatMessages([...nextMessages, { role: 'assistant', content: response }])

      // Save AI response to SQLite
      await invoke('save_message', { conversationId: convId, role: 'assistant', content: response })

      // Refresh conversation list
      const convs = await invoke('get_conversations')
      setChatHistory(convs.map(c => ({ id: c.id, title: c.title, preview: c.title })))
    } catch (e) {
      setChatError(String(e))
      setChatMessages(nextMessages)
    } finally {
      setChatLoading(false)
    }
  }

  const handleChatKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendChat()
    }
  }

  const copyDebugLogs = async () => {
    try {
      const logs = (window.__DEBUG_LOGS__ || []).slice(-200)
      const text = logs.map((l) => `[${new Date(l.t).toLocaleTimeString()}] ${l.level}: ${l.m}`).join('\n')
      await navigator.clipboard.writeText(text || 'No logs')
      alert('Logs copied')
    } catch (e) {
      console.error('Failed to copy logs:', e)
    }
  }

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight
    }
  }, [chatMessages])

  const loadLanguage = async () => {
    try {
      const lang = await invoke('get_language')
      setLocale(lang || 'en')
    } catch (e) {
      console.error('Failed to load language:', e)
    }
  }

  const handleToggleLanguage = async () => {
    const newLocale = locale === 'en' ? 'zh-CN' : 'en'
    setLocale(newLocale)
    try {
      await invoke('set_language', { language: newLocale })
    } catch (e) {
      console.error('Failed to save language:', e)
    }
  }

  const handlePetMouseDown = async (event) => {
    if (event.button !== 0) return
    pointerDownRef.current = { x: event.clientX, y: event.clientY, moved: false }
    const onMove = (e) => {
      const p = pointerDownRef.current
      if (!p) return
      if (Math.abs(e.clientX - p.x) > 5 || Math.abs(e.clientY - p.y) > 5) {
        p.moved = true
        window.removeEventListener('pointermove', onMove)
        getCurrentWindow().startDragging().catch((err) => {
          console.error('Failed to start window drag:', err)
        })
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      pointerDownRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleOpenChat = async () => {
    setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] open-chat start`])
    try {
      await invoke('show_chat_window')
      setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] open-chat invoke ok`])
      return
    } catch (invokeErr) {
      console.warn('[DEBUG PROBE 23] show_chat_window invoke failed', invokeErr)
      setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] open-chat invoke failed, try fallback`])
    }

    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const existing = WebviewWindow.getByLabel('chat')
      if (existing) {
        await existing.show()
        await existing.setFocus()
        setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] open-chat existing window focused`])
        return
      }

      new WebviewWindow('chat', {
        url: 'index.html',
        title: locale === 'zh-CN' ? '和宠物对话' : 'Chat with Pet',
        width: 420,
        height: 560,
        center: true,
        visible: true,
      })
      setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] open-chat created window`])
    } catch (fallbackErr) {
      console.error('[DEBUG PROBE 24] open-chat fallback failed', fallbackErr)
      setDebugLogs((prev) => [...prev.slice(-50), `[${new Date().toLocaleTimeString()}] open-chat fallback failed`])
    }
  }

  const handlePetDoubleClick = async () => {
    try {
      try { window.__DEBUG_LOGS__ = window.__DEBUG_LOGS__ || []; window.__DEBUG_LOGS__.push({t: Date.now(), m:'dblclick'}) } catch(_){}
      await handleOpenChat()
    } catch (e) {
      console.error('Failed to open chat on double click:', e)
    }
  }

  const handleBubbleClick = async (event) => {
    event.stopPropagation()
    if (!bubble?.source) return

    try {
      await invoke('focus_live_source', { source: bubble.source })
    } catch (e) {
      console.error('Failed to focus live source:', e)
    }
  }

  const handlePetPointerUp = async (event) => {
    const p = pointerDownRef.current
    pointerDownRef.current = null
    if (event.button !== 0) return
    if (!p || p.moved) return

    const now = Date.now()
    if (now - lastClickRef.current < 300) {
      lastClickRef.current = 0
      await handleOpenChat()
    } else {
      lastClickRef.current = now
      await handleTrigger('jumping')
    }
  }

  // Pet window
  if (windowIdentity !== 'settings' && !isSettings && windowIdentity !== 'chat' && !isChat) {
    return (
      <div
        className="pet-container"
        style={{ width: windowWidth, height: windowHeight, '--pet-display-height': `${displayHeight}px` }}
        onPointerDown={handlePetMouseDown}
        onPointerUp={handlePetPointerUp}
      >
        {showDebug && (
          <div style={{ position: 'fixed', top: 8, left: 8, zIndex: 9999, background: 'rgba(0,0,0,0.88)', color: '#0f0', padding: 8, borderRadius: 6, fontSize: 11, lineHeight: '14px', maxWidth: 320, pointerEvents: 'auto' }}>
            <div><b>Pet Debug</b></div>
            <div>windowIdentity: {windowIdentity}</div>
            <div>isSettings: {String(isSettings)}</div>
            <div>isChat: {String(isChat)}</div>
            <div>lastEvents:</div>
            <div style={{ maxHeight: 80, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{debugLogs.slice(-8).join('\n')}</div>
            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
              <button className="button button-ghost" onClick={() => setDebugHiddenByUser(true)}>Hide</button>
              <button className="button button-ghost" onClick={() => {
                try {
                  const text = (window.__DEBUG_LOGS__ || []).slice(-100).map(x => `${new Date(x.t).toLocaleTimeString()} [${x.level}] ${x.m}`).join('\n')
                  navigator.clipboard.writeText(text)
                } catch (_) {}
              }}>CopyLogs</button>
            </div>
          </div>
        )}
        {bubble?.text && (
          <div
            className={`pet-bubble ${bubble.source ? 'clickable' : ''}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleBubbleClick}
            title={bubble.sourceLabel || bubble.source}
          >
            {bubble.text}
          </div>
        )}
        {spritesheet ? (
          <div
            className="pet-sprite"
            onDoubleClick={handlePetDoubleClick}
            style={{
              backgroundImage: `url(${spritesheet})`,
              backgroundPosition: getBackgroundPosition(),
              backgroundSize: `${ATLAS_WIDTH * petScale}px ${ATLAS_HEIGHT * petScale}px`,
              width: displayWidth,
              height: displayHeight,
            }}
          />
        ) : (
          <div style={{ 
            width: displayWidth, 
            height: displayHeight, 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            color: '#666',
            fontSize: 12,
          }}>
            {t('noLoaded')}
          </div>
        )}
      </div>
    )
  }


  // Chat window
  if (windowIdentity === 'chat' || isChat) {
    const filteredHistory = searchQuery
      ? chatHistory.filter(h => h.title.toLowerCase().includes(searchQuery.toLowerCase()) || h.preview.toLowerCase().includes(searchQuery.toLowerCase()))
      : chatHistory

    const handleNewChat = async () => {
      try {
        const newId = await invoke('create_conversation', { title: '新对话' })
        setActiveChatId(newId)
        setChatMessages([])
        setChatInput('')
        setChatError('')
        const convs = await invoke('get_conversations')
        setChatHistory(convs.map(c => ({ id: c.id, title: c.title, preview: c.title })))
      } catch (e) {
        console.error('Failed to create conversation:', e)
      }
    }

    const handleDeleteChat = async (id) => {
      try {
        await invoke('delete_conversation', { id })
        if (activeChatId === id) {
          setActiveChatId(null)
          setChatMessages([])
        }
        const convs = await invoke('get_conversations')
        setChatHistory(convs.map(c => ({ id: c.id, title: c.title, preview: c.title })))
      } catch (e) {
        console.error('Failed to delete conversation:', e)
      }
    }

    const handleSelectChat = async (id) => {
      try {
        setActiveChatId(id)
        const msgs = await invoke('get_messages', { conversationId: id })
        setChatMessages(msgs.map(m => ({ role: m.role, content: m.content })))
      } catch (e) {
        console.error('Failed to load messages:', e)
      }
    }

    return (
      <div className="chat-root">
        {/* Sidebar */}
        <div className={`chat-sidebar ${sidebarOpen ? "" : "collapsed"}`}>
          <div className="chat-sidebar-header">
            <button className="chat-sidebar-close" onClick={() => setSidebarOpen(false)}>✕</button>
            <button className="chat-new-chat-btn" onClick={handleNewChat}>＋ 新对话</button>
          </div>
          <div className="chat-history-list">
            {filteredHistory.map((h) => (
              <div
                key={h.id}
                className={`chat-history-item ${h.id === activeChatId ? "active" : ""}`}
                onClick={() => handleSelectChat(h.id)}
              >
                <div className="chat-history-title">{h.title}</div>
                <div className="chat-history-preview">{h.preview}</div>
                <button className="chat-history-delete" onClick={(e) => { e.stopPropagation(); handleDeleteChat(h.id) }}>✕</button>
              </div>
            ))}
            {filteredHistory.length === 0 && (
              <div style={{ padding: '20px 12px', textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>暂无对话</div>
            )}
          </div>
          <div className="chat-sidebar-search">
            <input
              className="chat-search-input"
              placeholder="搜索对话..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Main area */}
        <div className="chat-main">
          <header className="chat-header">
            <div className="chat-header-left">
              <div className="chat-traffic-lights">
                <button className="chat-traffic-light chat-traffic-light-close" onClick={() => getCurrentWindow().hide()}><span className="chat-traffic-light-icon">✕</span></button>
                <button className="chat-traffic-light chat-traffic-light-minimize"><span className="chat-traffic-light-icon">−</span></button>
                <button className="chat-traffic-light chat-traffic-light-maximize"><span className="chat-traffic-light-icon">◇</span></button>
              </div>
              <button className="chat-sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
              <div className="chat-avatar">🤖</div>
              <span className="chat-title">{t('chatTitle')}</span>
            </div>
            <div className="chat-header-right">
              <div className="chat-lang-toggle">
                <button className={`chat-lang-btn ${locale === "zh-CN" ? "active" : ""}`} onClick={() => locale !== "zh-CN" && handleToggleLanguage()}>中文</button>
                <button className={`chat-lang-btn ${locale === "en" ? "active" : ""}`} onClick={() => locale !== "en" && handleToggleLanguage()}>EN</button>
              </div>
            </div>
          </header>

          <div ref={chatMessagesRef} className="chat-messages">
            {chatMessages.length === 0 && (
              <div className="chat-empty">
                <div className="chat-empty-icon">💬</div>
                <div className="chat-empty-text">{t('chatInputPlaceholder')}</div>
              </div>
            )}
            {chatMessages.map((m, idx) => (
              <div key={idx} className={`chat-msg chat-msg-${m.role}`} style={{ animationDelay: `${idx * 0.06}s` }}>
                <div className={`chat-msg-avatar chat-msg-avatar-${m.role}`}>
                  {m.role === 'user' ? '👤' : '🤖'}
                </div>
                <div className="chat-msg-bubble">{m.content}</div>
              </div>
            ))}
          </div>

          {chatLoading && (
            <div className="chat-typing">
              <div className="chat-typing-dots">
                <div className="chat-typing-dot"></div>
                <div className="chat-typing-dot"></div>
                <div className="chat-typing-dot"></div>
              </div>
              <span className="chat-typing-text">思考中...</span>
            </div>
          )}
          {chatError && <div className="chat-error">{chatError}</div>}

          <div className="chat-input-area">
            <div className={`chat-input-wrapper ${inputPulse ? "chat-input-pulse" : ""}`}>
              <textarea
                className="chat-input"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleChatKeyDown}
                placeholder={t('chatInputPlaceholder')}
                rows={1}
              />
            </div>
            <button className="chat-send-btn" onClick={() => { setInputPulse(true); setTimeout(() => setInputPulse(false), 600); handleSendChat(); }} disabled={chatLoading || !chatInput.trim()}>
              {chatLoading ? '⏳' : '➤'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Settings window
  return (
    <div className="settings-container" style={{ position: 'relative', minHeight: '100vh', background: '#f6f7f9' }}>
      {showDebug && (
        <div style={{ position: 'fixed', top: 8, left: 8, zIndex: 9999, background: 'rgba(0,0,0,0.78)', color: '#0f0', padding: 8, borderRadius: 6, fontSize: 11, lineHeight: '14px', maxWidth: 320 }}>
          <div><b>Pet Debug</b></div>
          <div>windowIdentity: {windowIdentity}</div>
          <div>isSettings: {String(isSettings)}</div>
          <div>isChat: {String(isChat)}</div>
          <div>lastEvents:</div>
          <div style={{ maxHeight: 80, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{debugLogs.slice(-8).join('\n')}</div>
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <button className="button button-ghost" onClick={() => setShowDebug(false)}>Hide</button>
            <button className="button button-ghost" onClick={() => {
              try {
                const text = (window.__DEBUG_LOGS__ || []).slice(-100).map(x => `${new Date(x.t).toLocaleTimeString()} [${x.level}] ${x.m}`).join('\n')
                navigator.clipboard.writeText(text)
              } catch (_) {}
            }}>CopyLogs</button>
          </div>
        </div>
      )}
      <div className="settings-shell">
        <header className="settings-header">
          <div className="settings-title-row">
            <h1>{t('title')}</h1>
            <button className="button button-ghost language-toggle" onClick={handleToggleLanguage}>
              {locale === 'en' ? '中文' : 'EN'}
            </button>
            <button className="button button-ghost" onClick={copyDebugLogs} style={{ marginLeft: 8 }}>
              {t('copyLogs')}
            </button>
          </div>
        </header>

        <main className="settings-grid">
          <section className="settings-section pets-section">
            <div className="section-heading">
              <h2>{t('pets')}</h2>
              <span className="count-pill">{pets.length}</span>
            </div>
            <div className="pet-list">
              {pets.map((pet) => (
                <button
                  key={pet.id}
                  type="button"
                  className={`pet-item ${pet.has_spritesheet ? '' : 'disabled'}`}
                  onClick={() => pet.has_spritesheet && handleLoadPet(pet.id)}
                >
                  <span className="pet-avatar">{pet.display_name.slice(0, 1)}</span>
                  <span className="pet-item-info">
                    <span className="pet-item-name">{pet.display_name}</span>
                    <span className="pet-item-desc">{pet.description}</span>
                  </span>
                  {!pet.has_spritesheet && (
                    <span className="status-badge disconnected">{t('missingSprite')}</span>
                  )}
                </button>
              ))}
              {pets.length === 0 && (
                <div className="empty-state">
                  {t('noPets', { dir: userPetDir || t('userPetDirectory') })}
                </div>
              )}
            </div>
          </section>

          <section className="settings-section">
            <div className="section-heading">
              <h2>{t('wsServer')}</h2>
              <span className={`status-badge ${wsStatus.enabled ? 'connected' : 'disconnected'}`}>
                {wsStatus.enabled ? t('enabled') : t('disabled')}
              </span>
            </div>
            <div className="metric-row">
              <span>{t('port')}</span>
              <strong>{wsStatus.port}</strong>
            </div>
            <button className="button button-primary" onClick={handleToggleWs}>
              {wsStatus.enabled ? t('disable') : t('enable')}
            </button>
            <div className="helper-text">
              {t('connectTo', { port: wsStatus.port })}
            </div>
          </section>

          <section className="settings-section">
            <div className="section-heading">
              <h2>{t('petSize')}</h2>
            </div>
            <div className="segmented-options">
              {PET_SCALE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`segment-button ${Math.abs(petScale - option.value) < 0.01 ? 'selected' : ''}`}
                  onClick={() => handleSetPetScale(option.value)}
                >
                  <span>{t(option.labelKey)}</span>
                  <strong>{option.percent}%</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section live-section">
            <div className="section-heading">
              <h2>{t('liveSources')}</h2>
              <div className="heading-actions">
                <span className={`status-badge ${liveSourcePrefixEnabled ? 'connected' : 'disconnected'}`}>
                  {liveSourcePrefixEnabled ? t('prefixOn') : t('prefixOff')}
                </span>
                <button className="button button-ghost" onClick={handleToggleLiveSourcePrefix}>
                  {liveSourcePrefixEnabled ? t('hidePrefix') : t('showPrefix')}
                </button>
              </div>
            </div>
            <div className="live-sources">
              {LIVE_SOURCES.map((source) => {
                const status = liveSourcesStatus[source.key]
                const enabled = Boolean(status.enabled)
                const defaultPath = status.defaultPath || ''
                const path = status.path || defaultPath
                const defaultFocusTarget = status.defaultFocusTarget || ''
                const focusTarget = status.focusTarget || defaultFocusTarget

                return (
                  <div key={source.key} className="live-source-item">
                    <div className="live-source-main">
                      <div className="live-source-name">{source.label}</div>
                      <div className="live-source-path">{t('defaultLabel')} {defaultPath || t('loading')}</div>
                    </div>
                    <div className="live-source-path-field field-stack">
                      <label className="field-label">{t('defaultLabel')}</label>
                      <input
                        type="text"
                        value={path}
                        onChange={(e) => handleChangeLiveSourcePath(source.key, e.target.value)}
                      />
                      <label className="field-label">{t('focusTarget')}</label>
                      <input
                        type="text"
                        value={focusTarget}
                        placeholder={t('focusTargetHint')}
                        onChange={(e) => handleChangeLiveSourceFocusTarget(source.key, e.target.value)}
                      />
                    </div>
                    <div className="live-source-actions">
                      <span className={`status-badge ${enabled ? 'connected' : 'disconnected'}`}>
                        {enabled ? t('enabled') : t('disabled')}
                      </span>
                      <button className="button button-ghost" onClick={() => handleToggleLiveSource(source.key)}>
                        {enabled ? t('disable') : t('enable')}
                      </button>
                      <button className="button button-ghost" onClick={() => handleResetLiveSourcePath(source.key)}>
                        {t('reset')}
                      </button>
                      <button className="button button-primary" onClick={() => handleSaveLiveSourcePath(source.key)}>
                        {t('save')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="settings-section ai-chat-section">
            <div className="section-heading">
              <h2>{t('aiChat')}</h2>
            </div>
            <div className="field-stack">
              <label className="field-label">{t('apiKey')}</label>
              <div className="api-key-row">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t('apiKeyHint')}
                  className="api-key-input"
                />
                <button className="button button-ghost" onClick={() => setShowApiKey((v) => !v)}>
                  {showApiKey ? t('hide') : t('show')}
                </button>
                <button className="button button-primary" onClick={handleSaveApiKey}>
                  {t('save')}
                </button>
              </div>
            </div>
            <div className="chat-actions-row">
              <button className="button button-primary" onClick={handleTestConnection}>
                {t('testConnection')}
              </button>
              <button className="button button-primary" onClick={handleOpenChat}>
                {t('chatWithPet')}
              </button>
            </div>
          </section>

          <section className="settings-section message-section">
            <div className="section-heading">
              <h2>{t('messageMapping')}</h2>
            </div>
            <div className="message-map">
              {Object.entries(messageMap).map(([msgType, state]) => (
                <div key={msgType} className="message-map-item">
                  <label>{msgType}</label>
                  <select
                    value={state}
                    onChange={(e) => handleUpdateMessageMap(msgType, e.target.value)}
                  >
                    {Object.keys(STATE_ROWS).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section test-section">
            <div className="section-heading">
              <h2>{t('test')}</h2>
            </div>
            <div className="test-actions">
              {Object.keys(STATE_ROWS).map((state) => (
                <button className="button button-ghost" key={state} onClick={() => handleTrigger(state)}>
                  {state}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section directory-section">
            <div className="section-heading">
              <h2>{t('petDirectory')}</h2>
            </div>
            <div className="directory-row">
              <strong>{t('userPets')}</strong>
              <code>{userPetDir || t('loading')}</code>
            </div>
            <div className="directory-row">
              <strong>{t('builtInPets')}</strong>
              <code>{`{project}/pets/`}</code>
            </div>
            <div className="helper-text">
              {t('petFolderHint').split('\n').map((line) => (
                <span key={line}>
                  {line}
                  <br />
                </span>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}

export default App
