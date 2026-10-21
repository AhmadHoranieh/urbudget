#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // `--mcp` serves the budget's read tools to an MCP client instead of opening the window.
    if std::env::args().any(|a| a == "--mcp") {
        urbudget_lib::assistant::mcp::serve();
        return;
    }
    urbudget_lib::run();
}
