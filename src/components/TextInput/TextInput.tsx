import React, { useEffect, useRef, useState } from "react";
import { useToast } from "../../contexts/toast";

interface TextInputProps {
  isProcessing: boolean;
}

const TextInput: React.FC<TextInputProps> = ({ isProcessing }) => {
  const [text, setText] = useState("");
  const [textInputs, setTextInputs] = useState<Array<{ id: string; text: string }>>([]);
  const { showToast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load existing text inputs
  useEffect(() => {
    async function loadTextInputs() {
      try {
        const inputs = await window.electronAPI.getTextInputs();
        setTextInputs(inputs);
      } catch (error) {
        console.error("Error loading text inputs:", error);
      }
    }
    
    loadTextInputs();
    
    // Set up listeners for text input events
    const textInputAddedCleanup = window.electronAPI.onTextInputAdded((data: { id: string; text: string }) => {
      setTextInputs(prev => [...prev, data]);
    });
    
    const textInputDeletedCleanup = window.electronAPI.onTextInputDeleted((data: { id: string }) => {
      setTextInputs(prev => prev.filter(input => input.id !== data.id));
    });
    
    return () => {
      textInputAddedCleanup();
      textInputDeletedCleanup();
    };
  }, []);

  const handleAddTextInput = async () => {
    if (!text.trim()) return;
    
    try {
      const result = await window.electronAPI.addTextInput(text.trim());
      if (result.success) {
        setText("");
        showToast("Success", "Added", "success");
      } else {
        showToast("Error", "Failed", "error");
      }
    } catch (error) {
      console.error("Error adding text input:", error);
      showToast("Error", "Failed", "error");
    }
  };

  const handleDeleteTextInput = async (id: string) => {
    try {
      const result = await window.electronAPI.deleteTextInput(id);
      if (result.success) {
        showToast("Success", "Removed", "success");
      } else {
        showToast("Error", "Failed", "error");
      }
    } catch (error) {
      console.error("Error deleting text input:", error);
      showToast("Error", "Failed", "error");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Submit on Ctrl+Enter or Cmd+Enter
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      handleAddTextInput();
    }
  };

  // This function helps prevent focus issues
  const handleTextareaFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    // Set the prevent hide flag to true when focusing the textarea
    window.electronAPI.setPreventHide(true);
    
    // Force the focus to remain on the textarea
    if (textareaRef.current) {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
        }
      });
    }
    
    // Prevent the event from bubbling up to the window
    e.stopPropagation();
  };

  // Handle blur event to reset the prevent hide flag
  const handleTextareaBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    // Add small delay before turning off prevention to handle potential refocus
    setTimeout(() => {
      // Only turn off prevention if we're not focused on the textarea
      if (document.activeElement !== textareaRef.current) {
        window.electronAPI.setPreventHide(false);
      }
    }, 100);
    
    e.stopPropagation();
  };

  // Keep the handler for app relaunch but remove the button
  const handleRelaunchApp = async () => {
    try {
      showToast("", "Restarting...", "neutral");
      const result = await window.electronAPI.relaunchApp();
      if (!result.success) {
        showToast("Error", "Failed", "error");
      }
    } catch (error) {
      console.error("Error restarting application:", error);
      showToast("Error", "Failed", "error");
    }
  };

  return (
    <div className="w-full max-w-full opacity-80">
      <div className="flex flex-col">
        <div className="flex flex-col space-y-1">
          <textarea
            ref={textareaRef}
            className="w-full px-2 py-1.5 text-sm text-gray-200 bg-black/20 border-0 rounded-sm resize-y"
            rows={2}
            placeholder="Notes (Ctrl+Enter)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleTextareaFocus}
            onBlur={handleTextareaBlur}
            disabled={isProcessing}
            tabIndex={1}
            data-no-focus-steal="true"
          />
          <div className="flex justify-end">
            <button
              className="px-2 py-0.5 text-xs text-gray-400 bg-black/25 rounded-sm hover:bg-black/30 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleAddTextInput}
              disabled={isProcessing || !text.trim()}
            >
              Add
            </button>
          </div>
        </div>
      </div>
      
      {textInputs.length > 0 && (
        <div className="mt-1.5 space-y-1">
          <div className="space-y-1 max-h-[150px] overflow-y-auto">
            {textInputs.map((input) => (
              <div 
                key={input.id} 
                className="flex items-start py-1 px-1.5 text-xs text-gray-300 bg-black/15 rounded-sm"
              >
                <div className="flex-1 whitespace-pre-wrap">{input.text}</div>
                <button
                  className="ml-1 p-0.5 text-gray-500 hover:text-gray-400"
                  onClick={() => handleDeleteTextInput(input.id)}
                  disabled={isProcessing}
                  title="Remove"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TextInput; 