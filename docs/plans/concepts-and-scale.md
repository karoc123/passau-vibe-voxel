# Concepts and scale: material for the owner's grilling

Status: a study, not a decision (2026-11-26). It prepares the questions in section 6; `todo.md` and
`target-architecture.md` change only after the owner has answered. Every number is marked **measured** (this
machine, method in 3.1), **sourced** (link) or **estimated** (mine). Judgement is marked as such.

## 1. What comparable games teach

| Finding | Source |
|---|---|
| "My house" is a strong hook and a short one: Pokémon GO lost ~80 % of US daily users in months; who stayed, stayed for the loop. GeoGuessr grew through its competitive modes, not the map. | [Fortune](https://fortune.com/2016/08/27/pokemon-go-is-stalling-out/), [Amplitude](https://amplitude.com/blog/pokemon-go-lost-players-won-game), [OMR](https://omr.com/de/daily/geoguessr-world-cup-wachstum) |
| Browser games live on: load under 5 s, understood within 60 s, guest play, a link or party code. Typical web session 11–20 min; mobile median 4–5 min. | [Flurry, 7 years of .io](https://gitnation.com/contents/lessons-from-7-years-of-io-games-what-works-what-doesnt-work-where-to-go-from-here), [Poki 2026](https://poki.com/blog/state-of-web-gaming-report-2026), [GameAnalytics](https://www.pocketgamer.biz/five-key-takeaways-gameanalytics-h1-2019-mobile-benchmark-report/) |
| Player-made fun needs no AI: Among Us (4–15 players, 97 % mobile, cross-play), Prop Hunt, Minecraft Manhunt (1 runner, 3–5 hunters), Jet Lag hide and seek (rotating roles, longest hide wins). | [Among Us](https://en.wikipedia.org/wiki/Among_Us), [Manhunt](https://en.wikipedia.org/wiki/Dream_(YouTuber)), [Jet Lag rules](https://jetlag-hide-and-seek.pages.dev/docs/quick_start_guide/choosing_game_size) |
| Shared vehicles work when roles reward talking, not aim (Sea of Thieves: "tools not rules", cosmetic progress so friends can always play together). | [Xbox Wire](https://news.xbox.com/en-us/?p=191429) |
| Voxel shooter with digging worked as a simple free game (Ace of Spades: 16 v 16 CTF, ~550 k monthly players) and died when rebuilt with classes and a price. | [Wikipedia](https://en.wikipedia.org/wiki/Ace_of_Spades_(video_game)) |
| Destruction holds players only when it serves the objective (The Finals); as spectacle it gives a spike (Teardown multiplayer: record peak, then a tenth of it). | [GamesRadar](https://gamesradar.com/the-finals-new-season-is-even-more-explosive-than-its-debut-were-introducing-a-way-to-really-leverage-the-destruction), [PCGH](https://www.pcgameshardware.de/Teardown-Spiel-73677/News/Multiplayer-Update-Spielerrekord-Steam-1522044/) |
| Extraction and survival shooters need AI enemies, a loot economy, trusted hit registration, anti-cheat and a full queue. The Cycle: Frontier closed over cheating with ~2000 concurrent players; BattleBit (3 developers) fell from 87 k to under 1 k. PUBG and Tarkov rounds are 30–35 min. | [PC Gamer](https://www.pcgamer.com/with-thousands-still-playing-this-extraction-shooter-is-shutting-down-after-barely-a-year-online), [SteamDB](https://steamdb.info/app/671860/graphs) |
| A thin courier game can carry on mood alone (Easy Delivery Co, one developer, overwhelmingly positive). | [Steam](https://store.steampowered.com/app/3293010/Easy_Delivery_Co/) |
| Touch against mouse is unfair in aim duels: the big mobile shooters queue emulator players apart. | [Android Authority](https://www.androidauthority.com/call-of-duty-mobile-pc-emulator-1037744) |

Not verified: how long the "my house" novelty lasts, lobby sizes and round lengths of Krunker and Shell Shockers,
per-mode Hypixel numbers. Most sources above are secondary (press, Wikipedia); the Flurry talk, the Jet Lag rules and
Xbox Wire are primary.

Judgement: the cheap fun here is chase, hide, race and deliver, with the vehicles as the content. The direction in
`target-architecture.md` §0 (extraction, 30–45 min, armed AI groups, squads) is the most expensive genre on the list
and the one that fits phones and a browser worst.

## 2. Concepts

What exists and every concept uses: the city, the rivers, all crafts, ambient traffic, walking, other players seen,
craters. What none of them has yet: a round (start, end, score), roles, names, players on the map, a way into a
standing vehicle. Cost is in weeks of the current pace, estimated.

### A. Jagd durch Passau (manhunt, hide and seek)

- **Loop:** rounds of 8–10 min. One or two runners get a head start and must reach or hold places (Dom, Oberhaus,
  Ortspitze, Innsteg); hunters tag them by touch or by a hit. Roles rotate; the longest run wins. Vehicles stand at
  fixed spots, so the choice of route (bridge, boat across the Inn, paraglider off the Oberhaus) is the game.
- **Why fun:** local knowledge wins ("the alley behind the Rathaus"), the rivers and their bridges are natural
  chokepoints, no aim skill needed, a phone is a fair hunter or runner.
- **Needs:** round and role state on the wire, tag, a reveal ping every N seconds, players on the minimap, names,
  placed vehicles and getting in (F2), own avatar (E21).
- **Drops:** health, items, enemy AI, lag compensation, persistence, the launcher (or keeps it as a hunter's tool).
- **Cost:** 2–3 weeks to a first round. **Risk:** dull below 3 players; needs prediction of the own car to feel
  right over the internet (a chase at 150 ms lag).

### B. Dreiflüsse-Kurier and Rallye (deliver and race against the clock)

- **Loop:** pick up at A, deliver to B, 2–4 min; the route asks for a change of vehicle (car to the quay, boat across,
  on foot up the Stiege). Rallyes are fixed checkpoint chains for mixed vehicles. A board per route, held by the host.
- **Why fun:** works alone and with one friend, which the other concepts do not; the ambient traffic is the
  obstacle; the session is as short as a phone wants.
- **Needs:** pickups and checkpoints, a timer, a board file on the host, ghosts later. Roads a car can drive
  (`roads.md` becomes game-critical).
- **Drops:** all combat, all AI, interest in crowds. **Cost:** 1–2 weeks. **Risk:** thin; lives on the feel of
  driving and on the board. Parked once already; the reason should be asked (question 4).

### C. Brückenkopf (two teams, objectives, destruction)

- **Loop:** 12 min rounds, two teams of 4–8. The Altstadt is a peninsula: one team holds it, the other crosses
  (bridges, boats, air). Capture points or demolish a target; craters open and close routes.
- **Why fun:** Ace of Spades in a real old town; destruction with a purpose.
- **Needs:** health, damage, respawn, teams, the walker checked by the host (today the page owns the walk, ADR 0010),
  lag compensation, aim assist and a fairness answer for touch, craters that do not stall the host (3.3).
- **Drops:** AI enemies, loot. **Cost:** 6–10 weeks. **Risk:** cheating in a browser client, touch against mouse,
  needs 8+ players at once to be a game.

### D. Evakuierung (the direction of §0: co-op extraction)

- **Loop:** 30–45 min, squads of 3 dropped by paraglider, scavenge, fight armed groups, reach the evacuation.
- **Why fun:** the strongest fantasy and the best use of seats with roles (pilot and gunner).
- **Needs:** everything of C plus enemy AI that fights, loot and inventory, down and revive, missions, placed
  vehicles, enough players or bots to fill ~54 km².
- **Drops:** nothing. **Cost:** months. **Risk:** the genre's own (section 1); 30–45 min fits neither the web nor
  the phone session; with three players the map is empty unless AI carries it.

### E. Hochwasser (co-op rescue, no combat)

- **Loop:** 10–15 min. The water rises in steps (Passau 2013); the squad ferries people from roofs and quays to high
  ground by boat and helicopter before streets close. Score: people saved.
- **Why fun:** Passau's own story, co-op with roles, the crowd becomes the objective instead of scenery.
- **Needs:** a water level that changes (rendering, boats, walkers, cars all read water as static data today),
  people who wait and board, seats for passengers. **Drops:** weapons, AI enemies.
- **Cost:** 4–8 weeks, most of it water. **Risk:** the water tech; a real catastrophe as a game in the town it hit.
  §0 excluded a rising flood as a round's end; as a mode of its own the question is open.

Judgement: A and B share nearly all their new parts (round, markers, board, placed vehicles), need no AI and no
trusted hits, and are fair on a phone. C reuses that frame later. D is where C can grow, not where to start.

## 3. Server performance

### 3.1 Measured: the host under N simulated players

Method: the network host as shipped (PROTOCOL 16, Node 22.22, `ws` with deflate), real data, 30 Hz; N sockets from a
second process, each sending its view at 30 Hz; players' inputs fed to their sessions: 60 % on foot walking, 30 %
driving a traffic car, 10 % in a helicopter. "Cluster": all within 70 m of the cathedral. "Spread": random roads over
the map. 12 s warm-up, 15 s window, one run each (one repeat). Machine: i7-13700H under WSL2, shared with other
agents (load 5–12 of 20 threads), so p99 and max are noisy; means repeat within ~30 %. The script is not in the repo.

| Players | Sim ms/tick mean (p99) | Snapshots + send ms/tick | Sum of 33.3 | Process CPU | Wire kB/s per player | RSS GB |
|---|---|---|---|---|---|---|
| 1 | 2.6 (3.9) | 0.8 | 3.4 | 16 % | 3.5 | 0.49 |
| 10 cluster | 6.4 (11.0) | 4.4 | 10.8 | 43 % | 21 | 0.76 |
| 25 cluster | 6.2 (10.1) | 7.9 | 14.1 | 64 % | 45 | 0.97 |
| 50 cluster | 8.6 (18.8) | 25.1 | 33.7 | 110 % | host behind: 25 ticks/s | 1.24 |
| 10 spread | 16.4 (59.5) | 8.9 | 25.3 | 78 % | 5.2 | 1.33 |
| 25 spread | 14.0 (23.2); repeat 10.4 | 13.6; repeat 9.9 | 27.6 | 100 % | 7.3 | 1.45 |
| 50 spread | 18.5 (49.9) | 25.3 | 43.8 | 110 % | host behind: 23 ticks/s, clients got 0.8 messages/s | 1.71 |

Weapons, 25 clustered, 17 on foot firing (one run each, the noisiest numbers here):

| Fire | Sim ms/tick mean | p95 | Ticks over 33 ms |
|---|---|---|---|
| none | 6.2 | 9.0 | 0 of 450 |
| MG only, 10 shots/s each | 18.3 | 72 | 86 of 435 |
| launcher only, 1 grenade/s each | 24.7 (a second run under load: 80) | 58 (223) | 142 of 440 |
| launcher only, 5 players | 14.0 | 39 | 48 of 450 |

### 3.2 The bottlenecks, with evidence

1. **Snapshots, not the simulation, fill the tick.** At 50 players they cost 25 ms of 33, three times the sim. Each
   session's snapshot walks every agent of the world: spread players cost 0.5 ms each although each sees little,
   clustered ones 0.25–0.5 ms. CPU profile (25 spread): of the busy time about 40 % is snapshot building, the
   positions computed for the interest filter, and JSON; the traffic's own step about 13 %; the frames that can be attributed to Rapier under 5 %.
2. **Bytes per player grow with the players nearby.** 3.5 kB/s alone, 21 with ten, 45 with 25 at one square: over the
   20 kB/s mean from about ten players together, at the 50 kB/s peak with 25. Bodies, crafts and avatars are sent
   whole every tick. 50 at one place would need ~35 Mbit/s up (estimated from the slope), a VDSL line's whole upload.
3. **Past one core the host does not degrade, it starves.** At 44 ms of work per 33 ms tick the clients received
   under one message a second. There is no rule for what gives way first.
4. **Firing stalled the tick** (fixed 2026-11-26, gate `load`). Counted: ~12 node loads a tick under fire, every one
   from a ground query. Each shot and each grenade's flight asked the height of every car and person in the world,
   and while any crater stood every person's height was asked every tick; their nodes, beyond the 96 held and the 9
   kept, were read, gunzipped and decoded again on the tick. Now only those near the track or in an edited box are
   asked, the host keeps 256 unheld nodes and reads and gunzips off the thread: 10 players, 3 firing, from p95
   46 ms to 11; 16 players from 48 to 15–19 (one loaded run 36), ~1 load in 10 s.
5. **Spread players pay for traffic.** Ten spread players reach the car cap (1400); sim cost triples against the
   cluster. This is what step 5 (flow, a 350 m agent ring) answers; the measurement confirms the step.
6. **Memory:** 0.5 GB empty, 1.2–1.7 GB at 50. A 2 GB machine is too small; 4 GB holds.

### 3.3 Raspberry Pi 5 and hosting

- A Pi 5 core scores ~770 in Geekbench 6 single-thread, the cheapest Hetzner vCPUs ~1050–1200 (sourced, user
  uploads: [Raspberry Pi](https://www.raspberrypi.com/news/benchmarking-raspberry-pi-5/),
  [Geekbench](https://browser.geekbench.com/v6/cpu/baseline/16192857)). This machine's CPU is about three times a Pi
  core (estimated, not measured here).
- **Estimated from the table:** today's code on a Pi 5 is at its tick with about 8–10 players at one place and
  with fewer spread out; a cheap vCPU holds about twice that. Nobody has measured it; no usable published
  measurement of any game server on a Pi 5 was found.
- The Pi throttles from 80 °C without a fan and holds ~60 °C with one
  ([Raspberry Pi](https://www.raspberrypi.com/news/heating-and-cooling-raspberry-pi-5/)); it draws 3–12 W, about
  15–30 € a year (estimated at 0.35 €/kWh).
- **Reaching a host at home is the harder part.** A page served over https may only open `wss://`, so the host needs
  a certificate and a name. Cable lines in Germany often have no inbound IPv4 (DS-Lite,
  [Vodafone forum](https://forum.vodafone.de/t5/Kabel-Tarife-Rechnung/IPv4-Portfreigabe/m-p/3209122)). A tunnel
  solves both; Cloudflare proxies WebSockets but may drop them on its restarts
  ([Cloudflare](https://developers.cloudflare.com/network/websockets/)). Upload: VDSL 40 Mbit/s.
- **A rented host:** Hetzner 2 vCPU / 4 GB from 6–17 € a month with 20 TB traffic (the cheapest lines were not
  orderable on 2026-11-26: [cost-optimised](https://www.hetzner.com/cloud/cost-optimized/),
  [regular](https://www.hetzner.com/cloud/regular-performance/)); netcup 2 cores / 4 GB 9.50 €
  ([netcup](https://www.netcup.com/de/server/vps)). The tiles (142 MB) fit any static host; Cloudflare R2 has no
  egress fee ([R2](https://developers.cloudflare.com/r2/pricing/)).

### 3.4 What others do, and what it means here

| Topic | Fact | Source |
|---|---|---|
| Tick budget | Valorant budgets 2.3 ms of a 7.8 ms tick; replication was among its largest costs. Minecraft slows game time when a tick overruns; EVE dilates time for crowds. | [Riot](https://www.riotgames.com/en/news/valorants-128-tick-servers), [EVE](https://www.eveonline.com/news/view/introducing-time-dilation-tidi) |
| Crowds | Fortnite's replication graph puts actors into grid cells and builds each cell's list once for all its clients. Folia's regions merge when players gather: sharding does not help a crowd. | [Epic](https://dev.epicgames.com/documentation/en-us/unreal-engine/replication-graph-in-unreal-engine), [Folia](https://docs.papermc.io/folia/reference/overview/) |
| Byte budget | A priority accumulator sends the most overdue objects first within a fixed packet size: 901 bodies in 32 kB/s. Deltas against an acked baseline give another order of magnitude. | [Fiedler](https://gafferongames.com/post/state_synchronization/) |
| Rapier | Web builds got 2–5 times faster in 2025; SIMD builds exist as a separate package; a voxel collider shape exists (experimental). Native is ahead of Jolt in the Rapier project's own Godot benchmark. | [Dimforge 2025](https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge), [changelog](https://raw.githubusercontent.com/dimforge/rapier.js/master/CHANGELOG.md), [godot.rapier.rs](https://godot.rapier.rs/blog/v0-35-0) |
| Deflate | `ws` warns of deflate's CPU and memory cost and of memory fragmentation under concurrency on Linux. | [ws README](https://github.com/websockets/ws/blob/master/README.md) |
| Encoding | MessagePack is not reliably faster than V8's JSON and only ~18 % smaller; the gain is in fixed layouts, quantising and deltas. | [msgpackr](https://raw.githubusercontent.com/kriszyp/msgpackr/HEAD/benchmark.md), Fiedler above |
| WebTransport | In Safari only from 26.4 (March 2026); Node's QUIC is experimental. A WebSocket fallback stays necessary. | [caniuse](https://caniuse.com/webtransport), [Node](https://nodejs.org/api/quic.html) |
| Runtime | Bun runs WebAssembly slower than Node in a 2026 suite (crypto code, a worst case). | [00f.net](https://00f.net/2026/06/23/webassembly-runtimes-2026/) |

Not found: a cost per Rapier body, a WASM-to-native ratio for Rapier, head-of-line blocking measured at 1–2 % loss,
bytes per player of shipped games from a primary source.

Judgement:

- Node, `ws`, Rapier as WebAssembly and one sim thread are right for 10–50 players. Rapier is under 5 % of the tick;
  a Rust host, another engine, Bun or sharding by area would solve a problem this host does not have.
- The work is in the send path: an index by cell so a session touches only what it can see, each cell's agents
  encoded once for all who see it, a byte budget per player with priorities, and a rule for overload. A typed-array
  wire comes after those, and no longer needs to wait for a Pi.
- Encoding and deflate can move to a worker thread later; a Pi has four cores and the sim uses one.

## 4. A candidate vision (one page; every line marked "open" is the owner's)

**Passau als Spielplatz.** Friends meet in the real Passau, in a browser, for a quarter of an hour.

- **Who:** the owner's circle and people who know Passau; they come by a link in a chat, without an account, under a
  name they type. *Open: locals only, or anyone.*
- **Where:** laptop and phone, the same game, over the internet. A phone is never the weaker player, so no mode
  rests on aim duels between touch and mouse. *Open: is that rule accepted (it excludes C and D as first modes).*
- **How many:** 3–8 at once is the normal evening, 16 a full round, 50 a stress test of the host, not a design goal.
  *Open: the owner's 10–50 stands in ADR 0008.*
- **How long:** a round takes 5–10 min, a session 15–20. One world stays up; players drop in and out; rounds start
  on their own when enough are there. Alone there is still something to do (routes against the board). *Open: one
  30–45 min round per server instead (§0).*
- **The feeling:** "I know a shortcut." The city is the opponent's cover and the player's advantage: bridges,
  Stiegen, the Ortspitze, the climb to the Oberhaus. Vehicles are found, shared and swapped. The living city
  (traffic, trains, ships) is the stage and the obstacle, not an enemy.
- **Destruction** is a tool with a purpose (open a way, block a bridge) and heals between rounds.
- **Not:** accounts, progression, an economy, enemy AI, realism over fun. *Open: all five.*
- **Hosting:** one small rented machine, or a Pi behind a tunnel for the owner's circle. *Open.*
- **First playable:** Jagd (A) and Kurier (B) on one round frame; Brückenkopf (C) when eight people ask for it.

## 5. What would change in the plan (after the answers)

`target-architecture.md`:

- §0 is replaced by the chosen vision. With short rounds and no AI: squads, down and revive, loot, the evacuation
  and creative mode as map maintenance leave the text.
- The goal line ("a Pi 5 hosts 10–50") needs a number that was measured or a different sentence (question 6).
- Section 3 gains the send path as its own concern: interest by cell (already named, not built), a byte budget per
  player, the overload rule. Step 8's "only then compact the wire" loses its condition.
- Step 6 (kept things on disk) loses its reason if rounds reset the world; a board file replaces it.

Todos that become obsolete or wait, if A and B are chosen: E15 health and items, lag compensation for hits (part of M6–M10),
kept things on disk, E20 as written, the parked-car cap's tie to step 6, FRAGEN 7 and 8 (player buildings, when
destruction resets: at the round's end).

New todos, in the order proposed:

1. A host friends can reach: `wss`, a name, a tunnel or a rented machine. Without it nothing below is played.
2. The round frame with its first mode: round and role state, names, players on the minimap, placed vehicles and
   getting in (F2), the own avatar (E21). The mode seam gets its first real user.
3. The send path: interest by cell, a byte budget per player, an overload rule; a load check with N sockets as a gate
   (it guards what a player notices: the host keeping its tick).
4. Step 5, flow, unchanged: it is what makes spread players cheap.
5. Prediction of the own car (step 7), earlier than planned if the first mode is a chase.
6. Weapons under load: the stall is fixed; a shot still walks every car and person on the map (cheaply).

## 6. Questions for the owner, the most plan-changing first

Each: the recommended answer and what the answer changes.

1. **Is §0 (extraction, 30–45 min, squads, armed AI) still the direction, or open again?** Recommend: open again;
   keep it as where the game may grow. *If it stays:* enemy AI, health, loot and trusted hits become the next
   months, and sections 4–5 here fall away. *If open:* questions 2–5 decide the game.
2. **How many people will really be online at once in the first half year?** Recommend: plan for 3–8, cap rounds
   at 16. *If 30–50 is real:* the send path (3.2) comes before any game work and the Pi is out. *If 3–8:* today's
   host nearly suffices and the game comes first.
3. **Short rounds in a world that stays up (5–10 min, drop in), or one long round per server?** Recommend: short.
   *Long:* needs a lobby, a full roster at the start and something for those who are out early; phones mostly leave.
4. **Which first mode: Jagd (A), Kurier (B), Brückenkopf (C)? And why was the courier parked?** Recommend: A and
   B on one frame, A first if three friends are at hand, else B. *If C:* the walker moves to the host, health and
   lag compensation come first, cost triples.
5. **Must it be fun alone?** Recommend: yes, through B. *If no:* B is dropped and every test needs three people.
6. **Is the Pi a goal or a wish?** Recommend: a wish; state the goal as "a 10 € machine hosts 16, a Pi hosts the
   owner's circle", and measure a Pi once one is at hand. *If a goal for 50:* the typed-array wire, the worker for
   encoding and probably fewer ambient agents become required work.
7. **Where does the host run and how do friends reach it?** Recommend: a rented 4 GB machine now (6–17 € a month),
   the page as static files beside it. *If at home:* a tunnel and its drops, or IPv6 only; a todo either way.
8. **Do players ever shoot each other?** Recommend: not in the first two modes; a hit may tag. *If yes:* host-checked
   walking (ADR 0010 reversed), lag compensation, a cheat answer for an open browser client, touch against mouse.
9. **Is "everyone at the Domplatz" a normal moment of the game?** Recommend: yes, objectives pull players together,
   so the byte budget per player is required at 16 already (21 kB/s with ten). *If rounds keep players apart:* it
   can wait.
10. **What gives way when the host is over its tick?** Recommend: first the ambient density, then the agents' send
    rate; never a player's own vehicle, never slow motion. *Any answer* is better than today's starving.
11. **How much living city does a round need?** Recommend: cars near players as now, people thinned, the mode sets
    it. *If the full city always:* step 5 moves before the game.
12. **What is destruction for?** Recommend: a scarce tool tied to the objective, healed at the round's end.
    *If free fire for all:* the host's stall under fire (3.2, 4) is a blocker, and craters need a rate limit anyway.
13. **Is the phone an equal player in every mode?** Recommend: yes, and that rule picks the modes. *If phones may be
    second class:* C and D open up earlier.
14. **Names and boards without accounts?** Recommend: a typed name, a board file on the host, nothing personal
    stored. *If accounts:* a login, a database and data-protection duties.
15. **For whom is the real city: people who know Passau, or anyone?** Recommend: people who know it; objectives are
    named places, the interface German first. *If anyone:* landmarks matter more than streets and onboarding grows.
16. **Is own-car prediction worth pulling forward?** Recommend: yes if A is first (a chase at 150 ms feels late).
    *If B first:* it can stay at step 7.
17. **Talking: pings and emotes, or voice in the game?** Recommend: pings now, voice stays in whatever the group
    already uses. *If in-game voice:* WebRTC and a relay, a project of its own.
18. **Does creative mode as the way to maintain the map stay in scope?** Recommend: park it; the pipeline maintains
    the map. *If it stays:* persistence (step 6) keeps its place.
19. **Hochwasser (E): wanted, and acceptable as a theme in Passau?** Recommend: later, as a mode once water can
    change. *If wanted soon:* water becomes the largest engine task.
