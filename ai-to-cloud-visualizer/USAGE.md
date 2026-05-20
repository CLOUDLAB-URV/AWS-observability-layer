# AI-to-Cloud Visualizer Usage Guide

Welcome to the **AI-to-Cloud Visualizer**! This extension intercepts AWS MCP operations (creations, deletions, updates) and automatically visualizes your cloud architecture using D2 diagrams. 

## General Workflow

1. **Start the Server:** Launch the WebSocket server to listen to incoming AWS operations.
2. **Project Selection:** Choose an existing project or create a new one. All your project files (Queue, Workflow history, and D2 Diagram) will be isolated in their own folder.
3. **Listen and Build:** As AWS commands are executed, they are queued. Use the Webview to prompt an LLM (Internal via Proxy or native VS Code Copilot) to generate your updated architecture diagram based on the queued commands.
4. **Inspect:** View your prompt histories, the raw JSON commands, and the resulting `.d2` file dynamically.

## Command Palette Commands (`Ctrl+Shift+P` / `Cmd+Shift+P`)

All commands utilize our **Smart Project Selection UI**. If the server is actively running on a project, that project will appear at the top of the list marked with a `$(radio-tower)` icon and `(Active / Listening)`.

| Command Name | Description |
|--------------|-------------|
| **Cloud Visualizer: Start/Stop Server** | Toggles the local WebSocket server (port 8080). If starting, it prompts you to select or create a project workspace. |
| **Cloud Visualizer: Start Server** | Explicitly starts the WebSocket server and prompts you to select/create the active project. |
| **Cloud Visualizer: Stop Server** | Explicitly stops the WebSocket server without toggling it back on. |
| **Cloud Visualizer: Create New Project** | Swiftly scaffold a completely new project workspace, bypassing the connection dialog. |
| **Cloud Visualizer: Change Active Project** | Hot-swaps the active project the WebSocket server writes to (and updates the Webview) without having to stop and restart the connection. |
| **Cloud Visualizer: Open Project (All)** | Prompts for a project and opens the `.d2` Diagram, `_queue.json`, and `_workflow.json` files in adjacent columns side-by-side. It also opens the live Webview for the D2 diagram. |
| **Cloud Visualizer: Open Project Diagram** | Opens the declarative `.d2` text file for the selected project in the active editor column. |
| **Cloud Visualizer: Open Project Queue** | Opens the `_queue.json` file for the selected project, revealing any pending/unprocessed AWS commands. |
| **Cloud Visualizer: Open Project Workflow** | Opens the `_workflow.json` file, revealing the comprehensive history of all AWS operations executed in the project. |
| **Cloud Visualizer: Open Project Webview** | Launches only the D2 Visualizer live webview panel to preview the architecture visually and interact with the generative AI updater. |

## Project Storage Structure

Projects are securely stored in the extension's local Global Storage. Each project maintains its own strictly isolated folder named after the project:
* `{project_name}_diagram.d2`: The declarative diagram code layout.
* `{project_name}_queue.json`: Pending incoming AWS operations wait here until processed by the LLM.
* `{project_name}_workflow.json`: Complete timeline record.
* `prompts/`: A subdirectory with historical Markdown prompts sent to the LLMs, each containing a timestamp to trace how inference was evolving.

## Using the Webview Actions

The D2 Visualizer Webview provides real-time SVG rendering of your `.d2` files and actionable buttons in its header:
* **Reload / Compile:** Manually re-compiles the current `.d2` file text to update the canvas.
* **Update (MCP):** Connects to a local proxy API (port 8081) to generate a new D2 model based on the current `.d2` state + the active `queue.json` pending items.
* **Update (Copilot):** Leverages the native VS Code Language Models (e.g., `gpt-4o` or the models you pick from the generated dropdown) to perform the exact same architecture design update locally directly through GitHub Copilot.
