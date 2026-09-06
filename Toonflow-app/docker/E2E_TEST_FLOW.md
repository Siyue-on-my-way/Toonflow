## E2E click-through flow

1. Open `http://8.148.26.166:2280` and sign in with the seeded admin account.
2. Open project **E2E全链路样例**. It contains the script **E2E全链路主脚本**, three assets with preset images, and one test clip.
3. Review the script. The seeded content contains three scenes: studio, subway, and launch event.
4. Check asset management. Assets **林晨**, **地铁车厢**, and **智能水杯** already have images; the clip **E2E测试片尾** can be selected in the workbench.
5. Open storyboard. Three storyboard frames are linked to their relevant assets and grouped into tracks `T01` and `T02`.
6. Generate or refresh storyboard images from the storyboard view.
7. Open the workbench. The two tracks contain the linked storyboard media; generate prompts and videos, then select the preferred result.
8. Open final composition. The material list includes uploaded/generated clips and the built-in ending video.

The seeded data is intentionally retained. Live image/video generation still uses the project's configured RunningHub model and can consume external credits; the assets and storyboards are usable even if those live calls are skipped.
