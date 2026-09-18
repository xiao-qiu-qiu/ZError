fn main() {
    // Without custom-protocol, generate_context! treats devUrl as a development
    // build and silently embeds no frontend assets, even with --release.
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_none()
    {
        panic!("Release builds require --features custom-protocol to embed frontend assets");
    }
    tauri_build::build()
}
