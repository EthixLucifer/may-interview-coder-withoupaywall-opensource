import fs from "node:fs"
import path from "node:path"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import * as axios from "axios"
import { app, BrowserWindow, dialog } from "electron"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"
import Anthropic from '@anthropic-ai/sdk';

// Interface for Gemini API requests
interface GeminiMessage {
  role: string;
  parts: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string;
    }
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    source?: {
      type: 'base64';
      media_type: string;
      data: string;
    };
  }>;
}
export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private geminiApiKey: string | null = null
  private anthropicClient: Anthropic | null = null
  private _previousConfig: any = null

  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    this.screenshotHelper = deps.getScreenshotHelper()

    // Initialize AI client based on config
    this.initializeAIClient();

    // Set default app mode if not set
    const config = configHelper.loadConfig();
    if (!config.mode) {
      config.mode = "coding";
      configHelper.saveConfig(config);
    }

    this._previousConfig = { ...config };

    // Listen for config changes to re-initialize the AI client
    configHelper.on('config-updated', () => {
      const newConfig = configHelper.loadConfig();
      if (this._previousConfig?.mode !== newConfig.mode) {
        this.deps.setProblemInfo(null);
        this.screenshotHelper.clearExtraScreenshotQueue();
        if (this.deps.getView() === "solutions") {
          this.deps.setView("queue");
        }
      }
      this._previousConfig = { ...newConfig };
      this.initializeAIClient();
    });
  }

  /**
   * Initialize or reinitialize the AI client with current config
   */
  private initializeAIClient(): void {
    try {
      const config = configHelper.loadConfig();
      console.log("Initializing AI client with provider:", config.apiProvider);

      // Add mode-specific model validation
      if (config.mode === "mcq") {
        if (!config.mcqExtractionModel) config.mcqExtractionModel = config.extractionModel;
        if (!config.mcqSolutionModel) config.mcqSolutionModel = config.solutionModel;
      }

      // Reset all clients first to avoid any stale client issues
      this.openaiClient = null;
      this.geminiApiKey = null;
      this.anthropicClient = null;

      if (config.apiProvider === "openai") {
        if (config.apiKey) {
          console.log("Creating OpenAI client with key:", config.apiKey.substring(0, 5) + '...');
          try {
            this.openaiClient = new OpenAI({
              apiKey: config.apiKey,
              timeout: 60000, // 60 second timeout
              maxRetries: 2   // Retry up to 2 times
            });
            console.log("OpenAI client initialized successfully");
          } catch (e) {
            console.error("Failed to initialize OpenAI client:", e);
            this.openaiClient = null;
          }
        } else {
          console.warn("No API key available, OpenAI client not initialized");
        }
      } else if (config.apiProvider === "gemini") {
        // Gemini client initialization
        if (config.apiKey) {
          console.log("Setting Gemini API key:", config.apiKey.substring(0, 5) + '...');
          this.geminiApiKey = config.apiKey;
          console.log("Gemini API key set successfully");
        } else {
          console.warn("No API key available, Gemini API key not set");
        }
      } else if (config.apiProvider === "anthropic") {
        // Anthropic client initialization
        if (config.apiKey) {
          console.log("Creating Anthropic client with key:", config.apiKey.substring(0, 5) + '...');
          try {
            this.anthropicClient = new Anthropic({
              apiKey: config.apiKey,
              timeout: 60000,
              maxRetries: 2
            });
            console.log("Anthropic client initialized successfully");
          } catch (e) {
            console.error("Failed to initialize Anthropic client:", e);
            this.anthropicClient = null;
          }
        } else {
          console.warn("No API key available, Anthropic client not initialized");
        }
      } else {
        console.error("Unknown API provider:", config.apiProvider);
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error);
      this.openaiClient = null;
      this.geminiApiKey = null;
      this.anthropicClient = null;
    }
  }

  private async waitForInitialization(
    mainWindow: BrowserWindow
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = 50 // 5 seconds total

    while (attempts < maxAttempts) {
      const isInitialized = await mainWindow.webContents.executeJavaScript(
        "window.__IS_INITIALIZED__"
      )
      if (isInitialized) return
      await new Promise((resolve) => setTimeout(resolve, 100))
      attempts++
    }
    throw new Error("App failed to initialize after 5 seconds")
  }

  private async getCredits(): Promise<number> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return 999 // Unlimited credits in this version

    try {
      await this.waitForInitialization(mainWindow)
      return 999 // Always return sufficient credits to work
    } catch (error) {
      console.error("Error getting credits:", error)
      return 999 // Unlimited credits as fallback
    }
  }

  private async getLanguage(): Promise<string> {
    try {
      // Get language from config
      const config = configHelper.loadConfig();
      if (config.language) {
        return config.language;
      }

      // Fallback to window variable if config doesn't have language
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        try {
          await this.waitForInitialization(mainWindow)
          const language = await mainWindow.webContents.executeJavaScript(
            "window.__LANGUAGE__"
          )

          if (
            typeof language === "string" &&
            language !== undefined &&
            language !== null
          ) {
            return language;
          }
        } catch (err) {
          console.warn("Could not get language from window", err);
        }
      }

      // Default fallback
      return "python";
    } catch (error) {
      console.error("Error getting language:", error)
      return "python"
    }
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const config = configHelper.loadConfig();
    console.log("Processing screenshots with provider:", config.apiProvider);

    // First verify we have a valid AI client
    if (config.apiProvider === "openai" && !this.openaiClient) {
      console.log("OpenAI client not initialized, attempting to initialize...");
      this.initializeAIClient();

      if (!this.openaiClient) {
        console.error("OpenAI client initialization failed");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "gemini" && !this.geminiApiKey) {
      console.log("Gemini API key not set, attempting to initialize...");
      this.initializeAIClient();

      if (!this.geminiApiKey) {
        console.error("Gemini API key initialization failed");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "anthropic" && !this.anthropicClient) {
      console.log("Anthropic client not initialized, attempting to initialize...");
      this.initializeAIClient();

      if (!this.anthropicClient) {
        console.error("Anthropic client initialization failed");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    }

    const view = this.deps.getView()
    console.log("Processing screenshots in view:", view)

    if (view === "queue") {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START)
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue()
      console.log("Processing main queue screenshots:", screenshotQueue)

      // Check if the queue is empty
      if (!screenshotQueue || screenshotQueue.length === 0) {
        console.log("No screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      // Check that files actually exist
      const existingScreenshots = screenshotQueue.filter(path => fs.existsSync(path));
      if (existingScreenshots.length === 0) {
        console.log("Screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      try {
        // Initialize AbortController
        this.currentProcessingAbortController = new AbortController()
        const { signal } = this.currentProcessingAbortController

        const screenshots = await Promise.all(
          existingScreenshots.map(async (path) => {
            try {
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )

        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);

        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data");
        }

        const result = await this.processScreenshotsHelper(validScreenshots, signal)

        if (!result.success) {
          console.log("Processing failed:", result.error)
          if (result.error?.includes("API Key") || result.error?.includes("OpenAI") || result.error?.includes("Gemini")) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.API_KEY_INVALID
            )
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
              result.error
            )
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error")
          this.deps.setView("queue")
          return
        }

        // Only set view to solutions if processing succeeded
        console.log("Setting view to solutions after successful processing")
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
          result.data
        )
        this.deps.setView("solutions")
      } catch (error: any) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error
        )
        console.error("Processing error:", error)
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            error.message || "Server error. Please try again."
          )
        }
        // Reset view back to queue on error
        console.log("Resetting view to queue due to error")
        this.deps.setView("queue")
      } finally {
        this.currentProcessingAbortController = null
      }
    } else {
      // view == 'solutions'
      const extraScreenshotQueue =
        this.screenshotHelper.getExtraScreenshotQueue()
      console.log("Processing extra queue screenshots:", extraScreenshotQueue)

      // Check if the extra queue is empty
      if (!extraScreenshotQueue || extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);

        return;
      }

      // Check that files actually exist
      const existingExtraScreenshots = extraScreenshotQueue.filter(path => fs.existsSync(path));
      if (existingExtraScreenshots.length === 0) {
        console.log("Extra screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START)

      // Initialize AbortController
      this.currentExtraProcessingAbortController = new AbortController()
      const { signal } = this.currentExtraProcessingAbortController

      try {
        // Get all screenshots (both main and extra) for processing
        const allPaths = [
          ...this.screenshotHelper.getScreenshotQueue(),
          ...existingExtraScreenshots
        ];

        const screenshots = await Promise.all(
          allPaths.map(async (path) => {
            try {
              if (!fs.existsSync(path)) {
                console.warn(`Screenshot file does not exist: ${path}`);
                return null;
              }

              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )

        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(Boolean);

        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data for debugging");
        }

        console.log(
          "Combined screenshots for processing:",
          validScreenshots.map((s) => s.path)
        )

        const result = await this.processExtraScreenshotsHelper(
          validScreenshots,
          signal
        )

        if (result.success) {
          this.deps.setHasDebugged(true)
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
            result.data
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            result.error
          )
        }
      } catch (error: any) {
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            error.message
          )
        }
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  private async processScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ): Promise<{
    success: boolean;
    data?: {
      code: string;
      thoughts: string[];
      time_complexity: string;
      space_complexity: string;
    };
    error?: string;
  }> {
    try {
      const config = configHelper.loadConfig();
      const mode = config.mode || "coding";
      const isMCQ = mode === "mcq";
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();

      // Step 1: Extract problem info using AI Vision API (OpenAI or Gemini)
      const imageDataList = screenshots.map(screenshot => screenshot.data);

      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: isMCQ ? "Analyzing MCQ questions from screenshots..." : "Analyzing problem from screenshots...",
          progress: 20
        });
      }

      // Modified extraction prompt with mode support
      const extractionSystemPrompt = isMCQ
        ? `You are an expert in Computer Science and Quantitative Aptitude with deep knowledge of algorithms, data structures, databases, operating systems, networks, programming, and mathematical reasoning.
Your task is to:
Carefully read and analyze all multiple-choice questions (MCQs) shown in the screenshots or input text.
Extract each MCQ clearly with its options.
Provide the correct answer for each question.
Explain why the selected answer is correct with reasoning based on standard academic and industry knowledge.
Avoid hallucinations — if a question is ambiguous, clearly state the uncertainty or missing data.
Strictly avoid guessing if the correct answer cannot be confidently determined from the available information.
Always verify correctness by mentally simulating, logically deducing, or using formulae/concepts.
Never fabricate answers. Prioritize accuracy over completion.
         IMPORTANT: Questions may be in various formats with different numbering styles and option formats (numbers, letters, or symbols). Return the information in a JSON format with an array of 'questions', where each question has: question_number, question_text, and options (key-value pairs with option letter/number and text). Just return the structured JSON without any other text.`
        : "You are a coding challenge interpreter. Analyze the screenshot of the coding problem and extract all relevant information. Return the information in JSON format with these fields: problem_statement, constraints, example_input, example_output. Just return the structured JSON without any other text.";

      let problemInfo;

      if (config.apiProvider === "openai") {
        // Verify OpenAI client
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize

          if (!this.openaiClient) {
            return {
              success: false,
              error: "OpenAI API key not configured or invalid. Please check your settings."
            };
          }
        }

        // Use OpenAI for processing
        const messages = [
          {
            role: "system" as const,
            content: extractionSystemPrompt
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: isMCQ
                  ? `You are an expert in Computer Science and Quantitative Aptitude with deep knowledge of algorithms, data structures, databases, operating systems, networks, programming, and mathematical reasoning.

Your task is to:

Carefully read and analyze all multiple-choice questions (MCQs) shown in the screenshots or input text.

Extract each MCQ clearly with its options.

Provide the correct answer for each question.

Explain why the selected answer is correct with reasoning based on standard academic and industry knowledge.

Avoid hallucinations — if a question is ambiguous, clearly state the uncertainty or missing data.

Strictly avoid guessing if the correct answer cannot be confidently determined from the available information.
Always verify correctness by mentally simulating, logically deducing, or using formulae/concepts.
Never fabricate answers. Prioritize accuracy over completion.

 The questions may appear in different formats such as numbered (1., 2.), lettered (a., b.), or with other markers. Options might be listed as A/B/C/D, a)/b)/c)/d), 1/2/3/4, or bullet points. 
                  
Please identify all questions and their options carefully and return in this JSON format:
{
  "questions": [
    {
      "question_number": "1",
      "question_text": "Full question text here",
      "options": {
        "A": "Text of option A",
        "B": "Text of option B",
        "C": "Text of option C", 
        "D": "Text of option D"
      }
    },
    {
      "question_number": "2",
      "question_text": "...",
      "options": { ... }
    }
  ]
}`
                  : `Extract the coding problem details from these screenshots. Return in JSON format. Preferred coding language we gonna use for this problem is ${language}.`
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        // Send to OpenAI Vision API
        const extractionResponse = await this.openaiClient.chat.completions.create({
          model: isMCQ ? (config.mcqExtractionModel || config.extractionModel || "gpt-4.1") : (config.extractionModel || "gpt-4.1"),
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });

        // Parse the response
        try {
          const responseText = extractionResponse.choices[0].message.content;
          console.log("Extraction response:", responseText); // Log for debugging

          // Handle when OpenAI might wrap the JSON in markdown code blocks
          const jsonMatch = responseText.match(/```(?:json)?([\s\S]*?)```/) || [null, responseText];
          const jsonText = jsonMatch[1].trim();

          try {
            problemInfo = JSON.parse(jsonText);
          } catch (parseError) {
            console.error("JSON parse error:", parseError);

            // Try more aggressive JSON extraction if initial parse fails
            const betterJsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (betterJsonMatch) {
              try {
                problemInfo = JSON.parse(betterJsonMatch[0]);
              } catch (deeperError) {
                console.error("Secondary JSON parse error:", deeperError);
                throw new Error("Failed to parse extracted information");
              }
            } else {
              throw new Error("Could not identify JSON structure in the response");
            }
          }

          // Validate and fix MCQ format if needed
          if (isMCQ) {
            problemInfo = this.validateAndFixMCQFormat(problemInfo, responseText);
          }
        } catch (error) {
          console.error("Error parsing OpenAI response:", error);
          return {
            success: false,
            error: "Failed to parse problem information. Please try again or use clearer screenshots."
          };
        }
      } else if (config.apiProvider === "gemini") {
        // Use Gemini API
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages: GeminiMessage[] = [
            {
              role: "user",
              parts: [
                {
                  text: isMCQ
                    ? `Extract all multiple choice questions from these screenshots. The questions may appear in different formats such as numbered (1., 2.), lettered (a., b.), or with other markers. Options might be listed as A/B/C/D, a)/b)/c)/d), 1/2/3/4, or bullet points. 
                    
Please identify all questions and their options carefully and return in this JSON format:
{
  "questions": [
    {
      "question_number": "1",
      "question_text": "Full question text here",
      "options": {
        "A": "Text of option A",
        "B": "Text of option B",
        "C": "Text of option C", 
        "D": "Text of option D"
      }
    },
    {
      "question_number": "2",
      "question_text": "...",
      "options": { ... }
    }
  ]
}`
                    : `Extract the coding problem details from these screenshots. Return in JSON format with these fields: problem_statement, constraints, example_input, example_output. Just return the structured JSON without any other text. Preferred coding language we gonna use for this problem is ${language}.`
                },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${isMCQ ? (config.mcqExtractionModel || config.extractionModel || "gemini-2.0-flash") : (config.extractionModel || "gemini-2.0-flash")}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;

          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }

          const responseText = responseData.candidates[0].content.parts[0].text;
          console.log("Gemini extraction response:", responseText); // Log for debugging

          // Handle when Gemini might wrap the JSON in markdown code blocks
          const jsonMatch = responseText.match(/```(?:json)?([\s\S]*?)```/) || [null, responseText];
          const jsonText = jsonMatch[1].trim();

          try {
            problemInfo = JSON.parse(jsonText);
          } catch (parseError) {
            // Try more aggressive JSON extraction if initial parse fails
            const betterJsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (betterJsonMatch) {
              problemInfo = JSON.parse(betterJsonMatch[0]);
            } else {
              throw new Error("Could not identify JSON structure in the response");
            }
          }

          // Validate and fix MCQ format if needed
          if (isMCQ) {
            problemInfo = this.validateAndFixMCQFormat(problemInfo, responseText);
          }
        } catch (error) {
          console.error("Error using Gemini API:", error);
          return {
            success: false,
            error: "Failed to process with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }

        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `Extract the coding problem details from these screenshots. Return in JSON format with these fields: problem_statement, constraints, example_input, example_output. Preferred coding language is ${language}.`
                },
                ...imageDataList.map(data => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const,
                    data: data
                  }
                }))
              ]
            }
          ];

          const response = await this.anthropicClient.messages.create({
            model: config.extractionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          const responseText = (response.content[0] as { type: 'text', text: string }).text;
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error: any) {
          console.error("Error using Anthropic API:", error);

          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to process with Anthropic API. Please check your API key or try again later."
          };
        }
      }

      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: isMCQ ? "MCQ questions analyzed successfully. Preparing to generate answers..." : "Problem analyzed successfully. Preparing to generate solution...",
          progress: 40
        });
      }

      // Store problem info in AppState
      this.deps.setProblemInfo(problemInfo);

      // Send first success event
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
          problemInfo
        );

        // Add MCQ response handling
        if (isMCQ) {
          const mcqResult = await this.handleMCQResponse(problemInfo, signal);
          if (mcqResult.success) {
            // Clear any existing extra screenshots before transitioning to solutions view
            this.screenshotHelper.clearExtraScreenshotQueue();

            // Final progress update
            mainWindow.webContents.send("processing-status", {
              message: "MCQ analysis completed successfully",
              progress: 100
            });

            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
              mcqResult.data
            );
            return { success: true, data: mcqResult.data };
          } else {
            throw new Error(
              mcqResult.error || "Failed to analyze MCQ questions"
            );
          }
        }

        // Generate solutions after successful extraction (for coding problems)
        const solutionsResult = await this.generateSolutionsHelper(signal);
        if (solutionsResult.success) {
          // Clear any existing extra screenshots before transitioning to solutions view
          this.screenshotHelper.clearExtraScreenshotQueue();

          // Final progress update
          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100
          });

          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            solutionsResult.data
          );
          return { success: true, data: solutionsResult.data };
        } else {
          throw new Error(solutionsResult.error || "Failed to generate solutions");
        }
      }

      return { success: false, error: "Failed to process screenshots" };
    } catch (error: any) {
      // If the request was cancelled, don't retry
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }

      // Handle OpenAI API errors specifically
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      } else if (error?.response?.status === 500) {
        return {
          success: false,
          error: "OpenAI server error. Please try again later."
        };
      }

      console.error("API Error Details:", error);
      return {
        success: false,
        error: error.message || "Failed to process screenshots. Please try again."
      };
    }
  }

  private async handleMCQResponse(problemInfo: any, signal: AbortSignal): Promise<{
    success: boolean;
    data?: {
      code: string;
      thoughts: string[];
      time_complexity: string;
      space_complexity: string;
      answers?: any;
      isMCQ?: boolean;
    };
    error?: string;
  }> {
    try {
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Analyzing MCQ questions and generating answers...",
          progress: 60
        });
      }

      const prompt = `
Analyze the following multiple choice questions:

${JSON.stringify(problemInfo.questions, null, 2)}

For each question, provide:
1. The correct answer (A, B, C, or D)
2. A detailed explanation of why this answer is correct
3. Brief analysis of why each other option is incorrect
4. Key concepts being tested in this question

Format your response as JSON with this structure:
{
  "answers": [
    {
      "question_number": 1,
      "question_text": "The full text of the question",
      "options": {
        "A": "Text of option A",
        "B": "Text of option B",
        "C": "Text of option C",
        "D": "Text of option D"
      },
      "correct_answer": "A", 
      "explanation": "detailed explanation",
      "analysis": {
        "A": "why A is correct",
        "B": "why B is wrong",
        "C": "why C is wrong",
        "D": "why D is wrong"
      },
      "key_concepts": ["concept1", "concept2"]
    }
  ]
}
`;

      let responseContent;

      if (config.apiProvider === "openai") {
        // OpenAI processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }

        // Send to OpenAI API
        const response = await this.openaiClient.chat.completions.create({
          model: config.mcqSolutionModel || config.solutionModel || "gpt-4.1",
          messages: [
            { role: "system", content: "You are an expert MCQ analyzer. Provide clear, accurate answers with detailed explanations." },
            { role: "user", content: prompt }
          ],
          max_tokens: 4000,
          temperature: 0.2
        });

        responseContent = response.choices[0].message.content;
      } else if (config.apiProvider === "gemini") {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: `You are an expert MCQ analyzer. Provide clear, accurate answers with detailed explanations for these MCQ questions:\n\n${prompt}`
                }
              ]
            }
          ];

          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.mcqSolutionModel || config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;

          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }

          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for MCQs:", error);
          return {
            success: false,
            error: "Failed to process with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        // Anthropic processing
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }

        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `You are an expert MCQ analyzer. Provide clear, accurate answers with detailed explanations for these MCQ questions:\n\n${prompt}`
                }
              ]
            }
          ];

          const response = await this.anthropicClient.messages.create({
            model: config.mcqSolutionModel || config.solutionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          responseContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for MCQs:", error);

          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          }

          return {
            success: false,
            error: "Failed to process with Anthropic API. Please check your API key or try again later."
          };
        }
      }

      // Parse MCQ response
      const parsedResponse = this.parseMCQResponse(responseContent, problemInfo);

      // Generate the MCQ solution as formatted code
      let mcqSolutionCode = this.generateMCQSolutionCode(parsedResponse);

      return {
        success: true,
        data: {
          code: mcqSolutionCode,
          thoughts: ["MCQ analysis completed"],
          answers: parsedResponse,
          isMCQ: true,
          time_complexity: "N/A - MCQ Mode",
          space_complexity: "N/A - MCQ Mode"
        }
      };
    } catch (error: any) {
      console.error("MCQ processing error:", error);
      return {
        success: false,
        error: error.message || "Failed to process MCQ questions"
      };
    }
  }

  private parseMCQResponse(content: string, problemInfo: any) {
    try {
      // Try to extract JSON object from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        // Ensure each answer has the question text from the original problem info
        if (parsed.answers && Array.isArray(parsed.answers) && problemInfo.questions) {
          parsed.answers.forEach((answer: any, index: number) => {
            if (problemInfo.questions[index]) {
              if (!answer.question_text) {
                answer.question_text = problemInfo.questions[index].question_text || "";
              }

              if (!answer.options && problemInfo.questions[index].options) {
                answer.options = problemInfo.questions[index].options;
              }
            }
          });
        }

        return parsed;
      }

      // If no JSON found, attempt to parse structured text
      const answers = [];
      const questionBlocks = content.split(/Question\s+\d+:|Q\d+:/gi).filter(block => block.trim().length > 0);

      for (let i = 0; i < questionBlocks.length; i++) {
        const block = questionBlocks[i];
        const correctAnswerMatch = block.match(/correct\s+answer\s*(?:is|:)\s*([A-D])/i);
        const correctAnswer = correctAnswerMatch ? correctAnswerMatch[1] : "?";

        const explanationMatch = block.match(/explanation\s*(?::|is)([\s\S]*?)(?:Analysis|Key concepts|$)/i);
        const explanation = explanationMatch ? explanationMatch[1].trim() : "No explanation provided";

        // Get question text and options from the original problem info
        const questionText = problemInfo.questions && problemInfo.questions[i] ?
          problemInfo.questions[i].question_text || "" : "";

        const options = problemInfo.questions && problemInfo.questions[i] ?
          problemInfo.questions[i].options || {} : {};

        answers.push({
          question_number: i + 1,
          question_text: questionText,
          options: options,
          correct_answer: correctAnswer,
          explanation: explanation,
          analysis: this.extractAnalysis(block),
          key_concepts: this.extractKeyConcepts(block)
        });
      }

      return { answers: answers.length > 0 ? answers : [] };
    } catch (e) {
      console.error("Error parsing MCQ response:", e);
      return { answers: [] };
    }
  }

  private extractAnalysis(block: string): Record<string, string> {
    const analysis: Record<string, string> = {};
    const options = ['A', 'B', 'C', 'D'];

    options.forEach(option => {
      const optionRegex = new RegExp(`${option}\\s*(?::|-)\\s*([^\\n]+)`, 'i');
      const match = block.match(optionRegex);
      if (match && match[1]) {
        analysis[option] = match[1].trim();
      }
    });

    return analysis;
  }

  private extractKeyConcepts(block: string): string[] {
    const keyConceptsMatch = block.match(/key\s+concepts\s*(?::|are|include)\s*([\s\S]*?)(?:\n\n|$)/i);
    if (keyConceptsMatch && keyConceptsMatch[1]) {
      return keyConceptsMatch[1]
        .split(/[,\n]/)
        .map(concept => concept.trim())
        .filter(Boolean);
    }
    return [];
  }

  private generateMCQSolutionCode(parsedResponse: any): string {
    if (!parsedResponse || !parsedResponse.answers || !Array.isArray(parsedResponse.answers) || parsedResponse.answers.length === 0) {
      return "// MCQ Solution - No answers found";
    }

    let code = "// MCQ Solutions\n\n";

    parsedResponse.answers.forEach((answer: any, index: number) => {
      const questionNumber = answer.question_number || (index + 1);
      code += `/* Question ${questionNumber} */\n`;
      code += `${answer.question_text || "Question text not available"}\n\n`;

      // Add options if available
      if (answer.options) {
        for (const [key, value] of Object.entries(answer.options)) {
          code += `${key}: ${value}\n`;
        }
        code += "\n";
      }

      code += `/* Answer: ${answer.correct_answer || "?"} */\n`;
      code += `/* Explanation: ${answer.explanation || "No explanation provided"} */\n\n`;
    });

    return code;
  }

  private async generateSolutionsHelper(signal: AbortSignal): Promise<{
    success: boolean;
    data?: {
      code: string;
      thoughts: string[];
      time_complexity: string;
      space_complexity: string;
    };
    error?: string;
  }> {
    try {
      const config = configHelper.loadConfig();
      const isMCQ = config.mode === "mcq";

      if (isMCQ) {
        return this.generateMCQSolution(signal);
      }

      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Creating optimal solution with detailed explanations...",
          progress: 60
        });
      }

      // Create prompt for solution generation
      const promptText = `
You are a world-class DSA problem solver & software engineer preparing candidates for top-tier tech interviews. Analyze the testcases of this coding question and give code that correctly passes all visible and hidden testcases and edgecases to solve this problem, give correct code by ensuring all testcases are passed both visible that are given and hidden which are not given, solution for the following coding problem:
before giving the final code critically analyze your solution to ensure that no testcases and edge cases are missed and all are passed, also give time complexity and space complexity of your code in the end. 
PROBLEM STATEMENT:
${problemInfo.problem_statement}

CONSTRAINTS:
${problemInfo.constraints || "No specific constraints provided."}

EXAMPLE INPUT:
${problemInfo.example_input || "No example input provided."}

EXAMPLE OUTPUT:
${problemInfo.example_output || "No example output provided."}

LANGUAGE: ${language}

I need the response in the following format:
1. Code: A clean implementation that passes all testcases for the question in ${language}
2. Your Thoughts: A list of key insights and reasoning behind your approach
3. Time complexity: O(X) with a detailed explanation (at least 2 sentences)
4. Space complexity: O(X) with a detailed explanation (at least 2 sentences)

For complexity explanations, please be thorough. For example: "Time complexity: O(n) because we iterate through the array only once. This is optimal as we need to examine each element at least once to find the solution." or "Space complexity: O(n) because in the worst case, we store all elements in the hashmap. The additional space scales linearly with the input size."

Your solution should be pass all testcases, edge cases and adhere to constraints mentioned in the question , well-commented, and handle edge cases.
`;

      let responseContent;

      if (config.apiProvider === "openai") {
        // OpenAI processing
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }

        // Send to OpenAI API
        const solutionResponse = await this.openaiClient.chat.completions.create({
          model: config.solutionModel || "gpt-4.1",
          messages: [
            {
              role: "system", content: `You are a world-class software engineer preparing candidates for top-tier tech interviews.
Your task is to solve the following problem in ${language} such that:
- The solution passes **all visible and hidden test cases**, including edge cases.
- You provide a well-commented, clean implementation.
- Your response contains no explanations before the code.` },
            { role: "user", content: promptText }
          ],
          max_tokens: 8192,
          temperature: 0.2
        });

        responseContent = solutionResponse.choices[0].message.content;
      } else if (config.apiProvider === "gemini") {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: `You are an expert coding interview assistant. Provide a clear, optimal solution with detailed explanations for this problem:\n\n${promptText}`
                }
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;

          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }

          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: "Failed to generate solution with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        // Anthropic processing
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }

        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `You are an expert coding interview assistant. Provide a clear, optimal solution with detailed explanations for this problem:\n\n${promptText}`
                }
              ]
            }
          ];

          // Send to Anthropic API
          const response = await this.anthropicClient.messages.create({
            model: config.solutionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          responseContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for solution:", error);

          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to generate solution with Anthropic API. Please check your API key or try again later."
          };
        }
      }

      // Extract parts from the response
      const codeMatch = responseContent.match(/```(?:\w+)?\s*([\s\S]*?)```/);
      const code = codeMatch ? codeMatch[1].trim() : responseContent;

      // Extract thoughts, looking for bullet points or numbered lists
      const thoughtsRegex = /(?:Thoughts:|Key Insights:|Reasoning:|Approach:)([\s\S]*?)(?:Time complexity:|$)/i;
      const thoughtsMatch = responseContent.match(thoughtsRegex);
      let thoughts: string[] = [];

      if (thoughtsMatch && thoughtsMatch[1]) {
        // Extract bullet points or numbered items
        const bulletPoints = thoughtsMatch[1].match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s*(.*)/g);
        if (bulletPoints) {
          thoughts = bulletPoints.map(point =>
            point.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()
          ).filter(Boolean);
        } else {
          // If no bullet points found, split by newlines and filter empty lines
          thoughts = thoughtsMatch[1].split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        }
      }

      // Extract complexity information
      const timeComplexityPattern = /Time complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:Space complexity|$))/i;
      const spaceComplexityPattern = /Space complexity:?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:[A-Z]|$))/i;

      let timeComplexity = "O(n) - Linear time complexity because we only iterate through the array once. Each element is processed exactly one time, and the hashmap lookups are O(1) operations.";
      let spaceComplexity = "O(n) - Linear space complexity because we store elements in the hashmap. In the worst case, we might need to store all elements before finding the solution pair.";

      const timeMatch = responseContent.match(timeComplexityPattern);
      if (timeMatch && timeMatch[1]) {
        timeComplexity = timeMatch[1].trim();
        if (!timeComplexity.match(/O\([^)]+\)/i)) {
          timeComplexity = `O(n) - ${timeComplexity}`;
        } else if (!timeComplexity.includes('-') && !timeComplexity.includes('because')) {
          const notationMatch = timeComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = timeComplexity.replace(notation, '').trim();
            timeComplexity = `${notation} - ${rest}`;
          }
        }
      }

      const spaceMatch = responseContent.match(spaceComplexityPattern);
      if (spaceMatch && spaceMatch[1]) {
        spaceComplexity = spaceMatch[1].trim();
        if (!spaceComplexity.match(/O\([^)]+\)/i)) {
          spaceComplexity = `O(n) - ${spaceComplexity}`;
        } else if (!spaceComplexity.includes('-') && !spaceComplexity.includes('because')) {
          const notationMatch = spaceComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = spaceComplexity.replace(notation, '').trim();
            spaceComplexity = `${notation} - ${rest}`;
          }
        }
      }

      const formattedResponse = {
        code: code,
        thoughts: thoughts.length > 0 ? thoughts : ["Solution approach based on efficiency and readability"],
        time_complexity: timeComplexity,
        space_complexity: spaceComplexity
      };

      return { success: true, data: formattedResponse };
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }

      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      }

      console.error("Solution generation error:", error);
      return { success: false, error: error.message || "Failed to generate solution" };
    }
  }

  private async generateMCQSolution(signal: AbortSignal): Promise<{
    success: boolean;
    data?: {
      code: string;
      thoughts: string[];
      time_complexity: string;
      space_complexity: string;
      answers?: any;
      isMCQ?: boolean;
    };
    error?: string;
  }> {
    const problemInfo = this.deps.getProblemInfo();
    if (!problemInfo) {
      return {
        success: false,
        error: "No MCQ problem information available"
      };
    }

    return await this.handleMCQResponse(problemInfo, signal);
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal
  ) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      // Get text inputs from screenshot helper
      const textInputs = this.screenshotHelper.getTextInputs();
      const hasTextInputs = textInputs.length > 0;
      const textInputContent = hasTextInputs 
        ? "\n\nAdditional context provided by the user:\n" + textInputs.map(input => input.text).join("\n\n")
        : "";

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Processing debug screenshots and text inputs...",
          progress: 30
        });
      }

      // Prepare the images for the API call
      const imageDataList = screenshots.map(screenshot => screenshot.data);

      let debugContent;

      if (config.apiProvider === "openai") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }

        const messages = [
          {
            role: "system" as const,
            content: `You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

Your response MUST follow this exact structure with these section headers (use ### for headers):
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification (e.g. \`\`\`java).`
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: `I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution. Here are screenshots of my code, the errors or test cases. Please provide a detailed analysis with:
1. What issues you found in my code
2. Specific improvements and corrections
3. Any optimizations that would make the solution better
4. A clear explanation of the changes needed${textInputContent}`
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing code and generating debug feedback...",
            progress: 60
          });
        }

        const debugResponse = await this.openaiClient.chat.completions.create({
          model: config.debuggingModel || "gpt-4.1",
          messages: messages,
          max_tokens: 4000,
          temperature: 0.2
        });

        debugContent = debugResponse.choices[0].message.content;
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          const debugPrompt = `
You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution.${textInputContent}

YOUR RESPONSE MUST FOLLOW THIS EXACT STRUCTURE WITH THESE SECTION HEADERS:
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification (e.g. \`\`\`java).
`;

          const geminiMessages = [
            {
              role: "user",
              parts: [
                { text: debugPrompt },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Gemini...",
              progress: 60
            });
          }

          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.debuggingModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;

          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }

          debugContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for debugging:", error);
          return {
            success: false,
            error: "Failed to process debug request with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }

        try {
          const debugPrompt = `
You are a coding interview assistant helping debug and improve solutions. Analyze these screenshots which include either error messages, incorrect outputs, or test cases, and provide detailed debugging help.

I'm solving this coding problem: "${problemInfo.problem_statement}" in ${language}. I need help with debugging or improving my solution.${textInputContent}

YOUR RESPONSE MUST FOLLOW THIS EXACT STRUCTURE WITH THESE SECTION HEADERS:
### Issues Identified
- List each issue as a bullet point with clear explanation

### Specific Improvements and Corrections
- List specific code changes needed as bullet points

### Optimizations
- List any performance optimizations if applicable

### Explanation of Changes Needed
Here provide a clear explanation of why the changes are needed

### Key Points
- Summary bullet points of the most important takeaways

If you include code examples, use proper markdown code blocks with language specification.
`;

          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: debugPrompt
                },
                ...imageDataList.map(data => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const,
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Claude...",
              progress: 60
            });
          }

          const response = await this.anthropicClient.messages.create({
            model: config.debuggingModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          debugContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for debugging:", error);

          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to process debug request with Anthropic API. Please check your API key or try again later."
          };
        }
      }


      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Debug analysis complete",
          progress: 100
        });
      }

      let extractedCode = "// Debug mode - see analysis below";
      const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }

      let formattedDebugContent = debugContent;

      if (!debugContent.includes('# ') && !debugContent.includes('## ')) {
        formattedDebugContent = debugContent
          .replace(/issues identified|problems found|bugs found/i, '## Issues Identified')
          .replace(/code improvements|improvements|suggested changes/i, '## Code Improvements')
          .replace(/optimizations|performance improvements/i, '## Optimizations')
          .replace(/explanation|detailed analysis/i, '## Explanation');
      }

      const bulletPoints = formattedDebugContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
      const thoughts = bulletPoints
        ? bulletPoints.map(point => point.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, '').trim()).slice(0, 5)
        : ["Debug analysis based on your screenshots"];

      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
        time_complexity: "N/A - Debug mode",
        space_complexity: "N/A - Debug mode"
      };

      return { success: true, data: response };
    } catch (error: any) {
      console.error("Debug processing error:", error);
      return { success: false, error: error.message || "Failed to process debug request" };
    }
  }

  public cancelOngoingRequests(): void {
    let wasCancelled = false

    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
      wasCancelled = true
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
      wasCancelled = true
    }

    this.deps.setHasDebugged(false)

    this.deps.setProblemInfo(null)

    const mainWindow = this.deps.getMainWindow()
    if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    }
  }

  /**
   * Validate and fix MCQ format issues
   */
  private validateAndFixMCQFormat(problemInfo: any, rawResponse: string): any {
    // If problemInfo is empty or missing questions array
    if (!problemInfo || !problemInfo.questions || !Array.isArray(problemInfo.questions) || problemInfo.questions.length === 0) {
      console.log("Invalid MCQ format, attempting to fix");

      // Try to extract questions from the raw text
      const extracted = this.extractQuestionsFromText(rawResponse);
      if (extracted.questions.length > 0) {
        return extracted;
      }

      // Create a basic structure if nothing else works
      return {
        questions: [
          {
            question_number: "1",
            question_text: "Failed to extract question text properly. Please check screenshots or try again.",
            options: {
              "A": "Option A",
              "B": "Option B",
              "C": "Option C",
              "D": "Option D"
            }
          }
        ]
      };
    }

    // Fix issues with questions that have been extracted
    for (let i = 0; i < problemInfo.questions.length; i++) {
      const question = problemInfo.questions[i];

      // Ensure question_number exists
      if (!question.question_number) {
        question.question_number = (i + 1).toString();
      }

      // Ensure options exist and are in the right format
      if (!question.options || Object.keys(question.options).length === 0) {
        // Attempt to extract options from question_text if options are missing
        const optionsExtract = this.extractOptionsFromText(question.question_text);

        if (optionsExtract.options && Object.keys(optionsExtract.options).length > 0) {
          question.question_text = optionsExtract.questionText;
          question.options = optionsExtract.options;
        } else {
          // Default empty options
          question.options = { "A": "No options extracted", "B": "", "C": "", "D": "" };
        }
      }

      // Normalize option keys to uppercase letters for consistency
      const normalizedOptions: Record<string, string> = {};
      Object.entries(question.options).forEach(([key, value]) => {
        // Convert numerical keys or lowercase to uppercase letters
        let normalizedKey = key;
        if (/^[1-4]$/.test(key)) {
          // Convert numbers 1-4 to letters A-D
          normalizedKey = String.fromCharCode(64 + parseInt(key));
        } else if (/^[a-d]$/.test(key.toLowerCase())) {
          normalizedKey = key.toUpperCase();
        }
        normalizedOptions[normalizedKey] = value as string;
      });
      question.options = normalizedOptions;
    }

    return problemInfo;
  }

  /**
   * Extract questions and options from unstructured text
   */
  private extractQuestionsFromText(text: string): any {
    const questions: any[] = [];

    // Look for question patterns
    const questionPatterns = [
      /(\d+)[\.\)][\s]*([^\n]+(?:(?!\d+[\.\)][\s]*)[^\n])*)/g,  // Numbered questions: "1. Question text"
      /([A-Za-z])[\.\)][\s]*([^\n]+(?:(?![A-Za-z][\.\)][\s]*)[^\n])*)/g  // Lettered questions: "A. Question text"
    ];

    for (const pattern of questionPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const questionNum = match[1];
        const fullText = match[2].trim();

        // Extract options from the question text
        const extractResult = this.extractOptionsFromText(fullText);

        questions.push({
          question_number: questionNum,
          question_text: extractResult.questionText,
          options: extractResult.options
        });
      }
    }

    // If no questions found with patterns, try a more aggressive approach
    if (questions.length === 0) {
      // Split by double newlines to identify question blocks
      const blocks = text.split(/\n\s*\n/).filter(block => block.trim().length > 0);

      blocks.forEach((block, i) => {
        const extractResult = this.extractOptionsFromText(block);
        if (Object.keys(extractResult.options).length > 0) {
          questions.push({
            question_number: (i + 1).toString(),
            question_text: extractResult.questionText,
            options: extractResult.options
          });
        }
      });
    }

    return { questions };
  }

  /**
   * Extract options from question text
   */
  private extractOptionsFromText(text: string): { questionText: string, options: Record<string, string> } {
    const options: Record<string, string> = {};
    let questionText = text;

    // Option patterns to look for
    const optionPatterns = [
      { pattern: /([A-D])[\.\)]\s*([^\n]+)(?=\s*[A-D][\.\)]|$)/g, groupKey: 1, groupValue: 2 },
      { pattern: /([a-d])[\.\)]\s*([^\n]+)(?=\s*[a-d][\.\)]|$)/g, groupKey: 1, groupValue: 2 },
      { pattern: /\s*([1-4])[\.\)]\s*([^\n]+)(?=\s*[1-4][\.\)]|$)/g, groupKey: 1, groupValue: 2 },
      { pattern: /(?:option|choice)\s*([A-Da-d])[:\.\)]\s*([^\n]+)/gi, groupKey: 1, groupValue: 2 }
    ];

    for (const { pattern, groupKey, groupValue } of optionPatterns) {
      // Reset pattern execution state
      pattern.lastIndex = 0;

      let match;
      let foundOptions = false;

      while ((match = pattern.exec(text)) !== null) {
        foundOptions = true;
        let key = match[groupKey].toUpperCase();
        if (/^[1-4]$/.test(key)) {
          // Convert numbers 1-4 to letters A-D
          key = String.fromCharCode(64 + parseInt(key));
        }
        options[key] = match[groupValue].trim();
      }

      if (foundOptions) {
        // Remove option text from question text
        for (const letter of ['A', 'B', 'C', 'D']) {
          const optRegex = new RegExp(`\\s*${letter}[.)]\\s*${options[letter]}`, 'i');
          questionText = questionText.replace(optRegex, '');
        }
        break; // Stop after finding options with one pattern
      }
    }

    // If no options found with explicit patterns, look for structured lines
    if (Object.keys(options).length === 0) {
      const lines = text.split('\n').filter(line => line.trim().length > 0);

      // Find the question text (usually the first line)
      if (lines.length > 0) {
        questionText = lines[0].trim();

        // Look for option-like lines in the remaining text
        const optionLetters = ['A', 'B', 'C', 'D'];
        let optionIndex = 0;

        for (let i = 1; i < lines.length && optionIndex < optionLetters.length; i++) {
          const line = lines[i].trim();
          if (line.length > 0) {
            options[optionLetters[optionIndex]] = line;
            optionIndex++;
          }
        }
      }
    }

    return { questionText, options };
  }
}