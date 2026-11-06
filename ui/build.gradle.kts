plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.compose)
}

val output =
    providers
        .gradleProperty("galleryBuildRoot")
        .orElse(providers.environmentVariable("GALLERY_BUILD_ROOT"))

require(output.isPresent) { "Set galleryBuildRoot to a build directory outside the repository" }

allprojects {
    layout.buildDirectory.set(file(output.get()).resolve("ui"))
}

val kotlinFormatter = configurations.create("kotlinFormatter")

kotlinFormatter.attributes.attribute(
    org.gradle.api.attributes.Bundling.BUNDLING_ATTRIBUTE,
    objects.named(org.gradle.api.attributes.Bundling.EXTERNAL),
)

kotlinFormatter.attributes.attribute(
    org.gradle.api.attributes.Usage.USAGE_ATTRIBUTE,
    objects.named(org.gradle.api.attributes.Usage.JAVA_RUNTIME),
)

kotlinFormatter.attributes.attribute(
    org.gradle.api.attributes.java.TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE,
    objects.named(org.gradle.api.attributes.java.TargetJvmEnvironment.STANDARD_JVM),
)

kotlinFormatter.attributes.attribute(
    org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType.attribute,
    org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType.jvm,
)

kotlinFormatter.attributes.attribute(
    org.gradle.api.attributes.Category.CATEGORY_ATTRIBUTE,
    objects.named(org.gradle.api.attributes.Category.LIBRARY),
)

kotlinFormatter.attributes.attribute(
    org.gradle.api.attributes.LibraryElements.LIBRARY_ELEMENTS_ATTRIBUTE,
    objects.named(org.gradle.api.attributes.LibraryElements.JAR),
)

dependencies {
    add(kotlinFormatter.name, libs.ktfmt)
    add(kotlinFormatter.name, libs.kotlin.stdlib)
}

tasks.register<JavaExec>("formatKotlin") {
    classpath = kotlinFormatter
    mainClass.set("com.facebook.ktfmt.cli.Main")
    args("--kotlinlang-style")
    args(fileTree("src") { include("**/*.kt") }.files.map { it.absolutePath })
    args("build.gradle.kts", "settings.gradle.kts")
}

kotlin {
    jvmToolchain(17)
    jvm()
    wasmJs {
        browser {
            commonWebpackConfig { outputFileName = "ui.js" }
            testTask { useKarma { useChromeHeadless() } }
        }
        binaries.executable()
    }
    sourceSets {
        wasmJsMain { kotlin.srcDir("../third_party/miuix_webfont") }
        commonMain.dependencies {
            implementation(libs.compose.runtime)
            implementation(libs.serialization.json)
        }
        commonTest.dependencies { implementation(kotlin("test")) }
        wasmJsMain.dependencies {
            implementation(libs.compose.ui)
            implementation(libs.compose.foundation)
            implementation(libs.compose.animation)
            implementation(libs.compose.resources)
        }
    }
}
