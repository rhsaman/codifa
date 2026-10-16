fn main() {
    tauri_build::build();

    // ONNX Runtime's prebuilt macOS binaries (fetched by `ort`'s
    // `download-binaries` feature) ship CoreML objects that call
    // `___isPlatformVersionAtLeast`, a helper that lives in compiler-rt.
    // rustc links with `-nodefaultlibs`, so clang never adds compiler-rt on its
    // own and the release link fails with
    // `Undefined symbols: ___isPlatformVersionAtLeast` as soon as LTO pulls
    // those objects in (without LTO the linker drops the unreferenced archive
    // members, which is why a non-LTO build links fine).
    //
    // Ask the toolchain where its compiler-rt archive lives instead of
    // hard-coding a path, and skip silently when clang cannot answer.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(output) = std::process::Command::new("clang")
        .arg("-print-file-name=libclang_rt.osx.a")
        .output()
    else {
        return;
    };
    let archive = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let path = std::path::Path::new(&archive);
    if !path.is_file() {
        return;
    }
    if let Some(dir) = path.parent() {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }
    println!("cargo:rustc-link-arg=-lclang_rt.osx");
}
