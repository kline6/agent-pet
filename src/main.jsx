import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Runtime debug log collector
;(function installDebugCollector(){
  try {
    const logs = []
    const orig = { error: console.error, warn: console.warn, debug: console.debug }
    function push(level, args){
      try {
        logs.push({ t: Date.now(), level, m: Array.from(args).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') })
        if (logs.length > 500) logs.splice(0, logs.length - 500)
        try { localStorage.setItem('__DEBUG_LOGS__', JSON.stringify(logs.slice(-200))) } catch (_) {}
      } catch(_){}
    }
    console.error = (...args) => { push('error', args); orig.error(...args) }
    console.warn = (...args) => { push('warn', args); orig.warn(...args) }
    console.debug = (...args) => { push('debug', args); orig.debug(...args) }
    window.__DEBUG_LOGS__ = logs
  } catch(_){}
})()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
