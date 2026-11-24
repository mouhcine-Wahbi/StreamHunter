import { Composition } from "remotion";
import { CleanGaming, type CleanGamingProps } from "./CleanGaming";

const defaults: CleanGamingProps = { src: "", durationInFrames: 30, fps: 30, splitY: 0, zoom: null, fadeInFrames: 0, captions: [] };

export function Root() {
  return (
    <Composition
      id="CleanGaming"
      component={CleanGaming}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      defaultProps={defaults}
      calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, props.durationInFrames), fps: props.fps })}
    />
  );
}
