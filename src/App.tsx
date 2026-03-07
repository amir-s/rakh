import { DemoIconShaderEffect } from "./components/IconShaderEffect";

export default function App() {
  return (
    <div className="min-h-screen bg-ink-950 text-white flex flex-col items-center">
      <div className="text-center my-auto">
        <DemoIconShaderEffect />
        <h1 className="font-display text-5xl leading-none font-semibold text-balance text-white">
          <span className="">Rakh</span>
          <span className="">.sh</span>
        </h1>
      </div>
    </div>
  );
}
