import { loadFont } from "@remotion/fonts";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { staticFile } from "remotion";

export const display = "GT Planar";

loadFont({
  family: display,
  url: staticFile("fonts/GT-Planar-Medium.woff2"),
  weight: "500",
});
loadFont({
  family: display,
  url: staticFile("fonts/GT-Planar-Bold.woff2"),
  weight: "700",
});

export const { fontFamily: mono } = loadGeistMono("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
});
