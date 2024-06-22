import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'

import BoardController from '../../board/controller.js';

function App() {
  const [board, setBoard] = useState(null)
  const [updater, setUpdater] = useState(null)

  return (
    <>
      <h1>6502life</h1>
      <div className="card">
        <button onClick={() => setUpdater(null)}>
          Start
        </button>
      </div>
    </>
  )
}

export default App
