import { supabase } from './supabaseClient.js?v=8'
import {
  initializeDriverPieDashboard
} from './dashboard-driver-pie.js?v=1'

function waitForDashboardBase(timeoutMilliseconds = 15000) {
  return new Promise((resolve, reject) => {
    const board = document.querySelector('.dashboard-board')

    if (!board) {
      reject(new Error('The dashboard board could not be found.'))
      return
    }

    if (document.querySelector('.phase-one-summary')) {
      resolve()
      return
    }

    const observer = new MutationObserver(() => {
      if (!document.querySelector('.phase-one-summary')) {
        return
      }

      clearTimeout(timeoutId)
      observer.disconnect()
      resolve()
    })

    const timeoutId = window.setTimeout(() => {
      observer.disconnect()
      reject(new Error('The live dashboard did not finish loading in time.'))
    }, timeoutMilliseconds)

    observer.observe(board, {
      childList: true,
      subtree: true
    })
  })
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const {
      data: { user },
      error
    } = await supabase.auth.getUser()

    if (error || !user) {
      return
    }

    await waitForDashboardBase()
    await initializeDriverPieDashboard()
  } catch (error) {
    console.error('Ticket driver dashboard error:', error)
  }
})
