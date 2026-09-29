import "./index.css";
import "./fonts";
import { Composition, Folder, Still } from "remotion";
import { AgentsScene } from "./scenes/Agents";
import { BundlingScene } from "./scenes/Bundling";
import { ClientSideScene } from "./scenes/ClientSide";
import { IntroScene } from "./scenes/Intro";
import { LightLeaksScene } from "./scenes/LightLeaks";
import { OutroScene } from "./scenes/Outro";
import { SkillsScene } from "./scenes/Skills";
import { SneakPeekScene } from "./scenes/SneakPeek";
import { SoundEffectsScene } from "./scenes/SoundEffects";
import { VercelScene } from "./scenes/Vercel";
import { Thumbnail } from "./Thumbnail";
import { WhatsNew } from "./WhatsNew";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="WhatsNew"
        component={WhatsNew}
        durationInFrames={7328}
        fps={30}
        width={1920}
        height={1080}
      />
      <Still id="Thumbnail" component={Thumbnail} width={1280} height={720} />
      <Folder name="WhatsNew-Scenes">
        <Composition
          id="Intro"
          component={IntroScene}
          durationInFrames={208}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="LightLeaks"
          component={LightLeaksScene}
          durationInFrames={720}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="SoundEffects"
          component={SoundEffectsScene}
          durationInFrames={1152}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Vercel"
          component={VercelScene}
          durationInFrames={1040}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Skills"
          component={SkillsScene}
          durationInFrames={608}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="ClientSide"
          component={ClientSideScene}
          durationInFrames={832}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Agents"
          component={AgentsScene}
          durationInFrames={976}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Bundling"
          component={BundlingScene}
          durationInFrames={720}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="SneakPeek"
          component={SneakPeekScene}
          durationInFrames={912}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Outro"
          component={OutroScene}
          durationInFrames={160}
          fps={30}
          width={1920}
          height={1080}
        />
      </Folder>
    </>
  );
};
