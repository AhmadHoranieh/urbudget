import SwiftUI
#if canImport(SafariServices) && os(iOS)
import SafariServices
import UIKit
#endif

extension Notification.Name {
    /// The in-app browser was closed, by the person or because a sign-in finished.
    static let urbudgetWebPageClosed = Notification.Name("UrBudgetWebPageClosed")
}

/// Web pages and files the services ask to show (`host://open-url`, `host://open-file`): account
/// pages, SimpleFIN setup, the assistant's ChatGPT sign-in, workbooks. They're presented over
/// whatever is on screen, including a sheet, in an in-app Safari view, so the app stays in the
/// foreground and a sign-in's local callback listener keeps running.
@MainActor
enum WebPresenter {
    #if canImport(SafariServices) && os(iOS)
    private static weak var page: SFSafariViewController?
    private static let delegate = SafariDelegate()

    static func open(_ url: URL) {
        guard let top = topmost() else { return }
        page?.dismiss(animated: false)
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.dismissButtonStyle = .done
        controller.delegate = delegate
        page = controller
        top.present(controller, animated: true)
    }

    /// Closes the in-app browser if one is showing (a sign-in's callback page, for instance).
    static func closePage() {
        guard let page else { return }
        page.dismiss(animated: true)
        self.page = nil
    }

    static func share(_ file: URL) {
        guard let top = topmost() else { return }
        let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        // iPad shows the share sheet as a popover, which needs somewhere to point.
        controller.popoverPresentationController?.sourceView = top.view
        controller.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        controller.popoverPresentationController?.permittedArrowDirections = []
        top.present(controller, animated: true)
    }

    /// The view controller on top: the deepest presented sheet, or the window's root.
    private static func topmost() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }

    private final class SafariDelegate: NSObject, SFSafariViewControllerDelegate {
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
            NotificationCenter.default.post(name: .urbudgetWebPageClosed, object: nil)
        }
    }
    #else
    static func open(_ url: URL) { NSWorkspace.shared.open(url) }
    static func closePage() {}
    static func share(_ file: URL) { NSWorkspace.shared.activateFileViewerSelecting([file]) }
    #endif
}
