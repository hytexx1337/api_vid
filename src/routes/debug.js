import { Router } from "express";
import { getLatinoStream } from "../providers/index.js";

const router = Router();

router.get("/debug/anime/:anilistId/:episode", async (req, res) => {
  const { anilistId, episode } = req.params;
  const [latinoResult] = await Promise.allSettled([getLatinoStream(anilistId, episode)]);
  res.json({
    animeav1: latinoResult.status === "fulfilled" ? latinoResult.value : { error: latinoResult.reason?.message },
  });
});

export default router;
