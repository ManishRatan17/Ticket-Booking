import { useEffect, useState } from 'react'
import './App.css'

function App() {
  const [health, setHealth] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(setHealth)
      .catch((err) => setError(err.message))
  }, [])

  return (
    <main className="app">
      <h1>React + Express</h1>
      <p>
        Edit <code>client/src/App.jsx</code> or <code>server/src/app.js</code> to get started.
      </p>
      <p className="status">
        API status:{' '}
        {error ? (
          <span className="err">unreachable ({error})</span>
        ) : health ? (
          <span className="ok">{health.status}</span>
        ) : (
          'checking…'
        )}
      </p>
    </main>
  )
}

export default App
