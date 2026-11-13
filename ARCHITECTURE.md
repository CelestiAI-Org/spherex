# How it works (pitch-slide version)

1. **Find** - given a star's name or coordinates, we look up every SPHEREx exposure that covers it in NASA/IPAC IRSA.
2. **Cut out** - we download only a small cutout (a few arcminutes) of each exposure, with its bad-pixel flags and sky-background estimate, and cache them ahead of time.
3. **Clean & stack** - the background is subtracted, bad pixels are masked, and exposures taken during the same visit are aligned on the sky and combined into one frame.
4. **Time-lapse** - one frame per visit, in time order, so motion and brightness changes show up as the sky is re-observed over months.
5. **Serve** - a small web API hands the frames (PNG + observation dates) to the web app, and can also show the difference between any two visits.
