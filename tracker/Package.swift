// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ActivityTracker",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ActivityTracker",
            path: "Sources",
            exclude: ["DesktopApp"]
        ),
        .executableTarget(
            name: "ActivityDesktop",
            path: "Sources/DesktopApp"
        )
    ]
)
