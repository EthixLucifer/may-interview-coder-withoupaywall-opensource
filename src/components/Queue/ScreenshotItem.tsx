// src/components/ScreenshotItem.tsx
import React from "react"
import { X } from "lucide-react"

interface Screenshot {
  path: string
  preview: string
}

interface ScreenshotItemProps {
  screenshot: Screenshot
  onDelete: (index: number) => void
  index: number
  isLoading: boolean
}

const ScreenshotItem: React.FC<ScreenshotItemProps> = ({
  screenshot,
  onDelete,
  index,
  isLoading
}) => {
  const handleDelete = async () => {
    await onDelete(index)
  }

  return (
    <>
      <div
        className={`relative w-[120px] h-[68px] opacity-90 ${
          isLoading ? "" : "group"
        }`}
      >
        <div className="w-full h-full relative">
          {isLoading && (
            <div className="absolute inset-0 bg-black bg-opacity-40 z-10 flex items-center justify-center">
              <div className="w-4 h-4 border border-gray-400 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          <img
            src={screenshot.preview}
            alt="Screenshot"
            className={`w-full h-full object-cover ${
              isLoading
                ? "opacity-50"
                : "cursor-pointer group-hover:brightness-90"
            }`}
          />
        </div>
        {!isLoading && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleDelete()
            }}
            className="absolute top-1 right-1 p-0.5 rounded-sm bg-black bg-opacity-40 text-gray-300 opacity-0 group-hover:opacity-70 transition-opacity duration-200"
            aria-label="Delete"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </>
  )
}

export default ScreenshotItem
