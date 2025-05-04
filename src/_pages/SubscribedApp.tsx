// file: src/components/SubscribedApp.tsx
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import Queue from "../_pages/Queue"
import Solutions from "../_pages/Solutions"
import TextInput from "../components/TextInput"
import { useToast } from "../contexts/toast"

interface SubscribedAppProps {
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
}

const SubscribedApp: React.FC<SubscribedAppProps> = ({
  credits,
  currentLanguage,
  setLanguage
}) => {
  const queryClient = useQueryClient()
  const [view, setView] = useState<"queue" | "solutions" | "debug">("queue")
  const [isProcessing, setIsProcessing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()

  // Let's ensure we reset queries etc. if some electron signals happen
  useEffect(() => {
    const cleanup = window.electronAPI.onResetView(() => {
      queryClient.invalidateQueries({
        queryKey: ["screenshots"]
      })
      queryClient.invalidateQueries({
        queryKey: ["problem_statement"]
      })
      queryClient.invalidateQueries({
        queryKey: ["solution"]
      })
      queryClient.invalidateQueries({
        queryKey: ["new_solution"]
      })
      setView("queue")
    })

    return () => {
      cleanup()
    }
  }, [])

  // Dynamically update the window size
  useEffect(() => {
    if (!containerRef.current) return

    const updateDimensions = () => {
      if (!containerRef.current) return
      const height = containerRef.current.scrollHeight || 600
      const width = containerRef.current.scrollWidth || 800
      window.electronAPI?.updateContentDimensions({ width, height })
    }

    // Force initial dimension update immediately
    updateDimensions()
    
    // Set a fallback timer to ensure dimensions are set even if content isn't fully loaded
    const fallbackTimer = setTimeout(() => {
      window.electronAPI?.updateContentDimensions({ width: 800, height: 600 })
    }, 500)

    const resizeObserver = new ResizeObserver(updateDimensions)
    resizeObserver.observe(containerRef.current)

    // Also watch DOM changes
    const mutationObserver = new MutationObserver(updateDimensions)
    mutationObserver.observe(containerRef.current, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    })

    // Do another update after a delay to catch any late-loading content
    const delayedUpdate = setTimeout(updateDimensions, 1000)

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      clearTimeout(fallbackTimer)
      clearTimeout(delayedUpdate)
    }
  }, [view])

  // Listen for events that might switch views or show errors
  useEffect(() => {
    const cleanupFunctions = [
      window.electronAPI.onSolutionStart(() => {
        setView("solutions")
      }),
      window.electronAPI.onUnauthorized(() => {
        queryClient.removeQueries({
          queryKey: ["screenshots"]
        })
        queryClient.removeQueries({
          queryKey: ["solution"]
        })
        queryClient.removeQueries({
          queryKey: ["problem_statement"]
        })
        setView("queue")
      }),
      window.electronAPI.onResetView(() => {
        queryClient.removeQueries({
          queryKey: ["screenshots"]
        })
        queryClient.removeQueries({
          queryKey: ["solution"]
        })
        queryClient.removeQueries({
          queryKey: ["problem_statement"]
        })
        setView("queue")
      }),
      window.electronAPI.onResetView(() => {
        queryClient.setQueryData(["problem_statement"], null)
      }),
      window.electronAPI.onProblemExtracted((data: any) => {
        if (view === "queue") {
          queryClient.invalidateQueries({
            queryKey: ["problem_statement"]
          })
          queryClient.setQueryData(["problem_statement"], data)
        }
      }),
      window.electronAPI.onSolutionError((error: string) => {
        showToast("Error", error, "error")
      })
    ]
    return () => cleanupFunctions.forEach((fn) => fn())
  }, [view])

  // Listen for processing state changes
  useEffect(() => {
    const cleanupProcessingStart = window.electronAPI.onSolutionStart(() => {
      setIsProcessing(true);
    });

    const cleanupProcessingSuccess = window.electronAPI.onSolutionSuccess(() => {
      setIsProcessing(false);
    });

    const cleanupProcessingError = window.electronAPI.onSolutionError(() => {
      setIsProcessing(false);
    });

    const cleanupDebugStart = window.electronAPI.onDebugStart(() => {
      setIsProcessing(true);
    });

    const cleanupDebugSuccess = window.electronAPI.onDebugSuccess(() => {
      setIsProcessing(false);
    });

    const cleanupDebugError = window.electronAPI.onDebugError(() => {
      setIsProcessing(false);
    });

    return () => {
      cleanupProcessingStart();
      cleanupProcessingSuccess();
      cleanupProcessingError();
      cleanupDebugStart();
      cleanupDebugSuccess();
      cleanupDebugError();
    };
  }, []);

  return (
    <div ref={containerRef} className="min-h-0">
      <div className="flex flex-col">
        {view === "queue" ? (
          <Queue
            setView={setView}
            credits={credits}
            currentLanguage={currentLanguage}
            setLanguage={setLanguage}
          />
        ) : view === "solutions" ? (
          <Solutions
            setView={setView}
            credits={credits}
            currentLanguage={currentLanguage}
            setLanguage={setLanguage}
          />
        ) : null}
        
        {/* More stealthy TextInput with minimal spacing */}
        <div className="w-1/2 mt-1 opacity-90">
          <TextInput isProcessing={isProcessing} />
        </div>
      </div>
    </div>
  )
}

export default SubscribedApp
