import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        // 「ファイル」アプリで図面を押して起動したときは、元の場所のまま渡されるので、アプリの中へ写してから Web 側へ渡す
        let contexts = connectionOptions.urlContexts
        guard contexts.contains(where: { $0.options.openInPlace }) else {
            SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
            return
        }
        let urls = contexts.map { Self.receivable($0) }
        // 起動したばかりでは Web 側の受け取り口がまだないので、画面が出てから渡す（Capacitor と同じ）
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(forName: .capacitorViewDidAppear, object: nil, queue: .main) { _ in
            if let token {
                NotificationCenter.default.removeObserver(token)
            }
            for url in urls {
                _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url)
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let inPlace = URLContexts.filter { $0.options.openInPlace }
        let copied = URLContexts.subtracting(inPlace)
        if !copied.isEmpty {
            SceneDelegateProxy.shared.scene(scene, openURLContexts: copied)
        }
        for context in inPlace {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: Self.receivable(context))
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// Web 側で読める URL。元の場所のまま渡されたものはアプリの中へ写し、写せなければ元の URL のまま渡す（読めない理由を Web 側で出す）
    private static func receivable(_ context: UIOpenURLContext) -> URL {
        guard context.options.openInPlace else { return context.url }
        return copyIntoInbox(context.url) ?? context.url
    }

    /// 元の場所のファイルを tmp/<Bundle ID>-Inbox/ へ写す。Web 側は読み終えた写しを消す（元のファイルには触れない）
    private static func copyIntoInbox(_ url: URL) -> URL? {
        let access = url.startAccessingSecurityScopedResource()
        defer {
            if access {
                url.stopAccessingSecurityScopedResource()
            }
        }
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("\(Bundle.main.bundleIdentifier ?? "app")-Inbox", isDirectory: true)
        let dest = dir.appendingPathComponent(url.lastPathComponent)
        var failed = false
        var coordination: NSError?
        // iCloud Drive の図面は端末にまだ落ちていないことがあるので、ファイルの調整役を通して読む
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordination) { source in
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                if fm.fileExists(atPath: dest.path) {
                    try fm.removeItem(at: dest)
                }
                try fm.copyItem(at: source, to: dest)
            } catch {
                failed = true
            }
        }
        return coordination == nil && !failed ? dest : nil
    }
}
