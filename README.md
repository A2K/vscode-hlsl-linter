

HLSL linter for VSCode
=======

## Setup

1. Compile or download a build of DirectX Shader Compiler:
https://github.com/Microsoft/DirectXShaderCompiler
2. Add `dxc` executable to `PATH` or set `hlsl.linter.executablePath`.
3. Add your shader include directories to `hlsl.linter.includeDirs` (Optional)

## Usage

Use `INPUTS` or `INPUTS(type)` comments to tell the linter what variables are defined outside the scope:
```glsl
// INPUTS(float2): uv
// INPUTS(Texture2D): Tex1
// INPUTS(SamplerState): LinearClamp
float4 color = Tex1.Sample(LinearClamp, uv);
```

Use `@nolint` inside a `//` comment to disable linting for a single line:
```glsl
float a = some_function(); // @nolint
```