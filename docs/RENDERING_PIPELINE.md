# Potok renderowania (Realistic Car Night)

Kompletny, modularny potok post-processingu zbudowany na `EffectComposer` z Three.js r170.
Cel: obraz w stylu AAA / „fotograficzny” (zamiast plastikowego looku WebGL) **i** stabilny FPS —
czyli ta sama sztuczka, którą robi DLSS/FSR: rysuj mniej pikseli, rekonstruuj czasowo,
dopraw fizycznie poprawnym oświetleniem i gradacją.

> Pliki: `src/render/Pipeline.js` (orkiestracja) + `src/render/pipeline/` (passy, jitter, LUT).
> Wszystko bez zewnętrznych assetów — LUT-y są generowane proceduralnie w JS.

---

## 1. Szybki start (jedna funkcja konfiguracyjna)

```js
import { createPipeline } from './render/Pipeline.js';

const pipe = createPipeline(renderer, scene, camera, {
  tier: 3,            // 0 NISKA · 1 ŚREDNIA · 2 WYSOKA · 3 ULTRA
  taa: true,          // skalowanie czasowe (TAA/TAAU)
  ao: true,           // ambient occlusion
  dof: true,          // głębia ostrości
  lut: 'natural',     // natural | film | vivid | none
  photo: false,       // true => pełna rozdzielczość wewnętrzna (zrzuty)
});

pipe.registerDynamic(carGroup);        // obiekty ruchome -> wektory ruchu
pipe.registerDynamic(trafficGroup);    // (idempotentne, można wołać po respawnie)

function loop() {
  updateGame();                        // fizyka, AI, kamera — wszystko PRZED beginFrame

  pipe.beginFrame();                   // jitter + macierze reprojekcji + uniformy
  pipe.setFocus(camera.position.distanceTo(car.position));
  pipe.setTime(clock.elapsedTime);
  pipe.setSpeedBlur(blur01);
  pipe.render();                       // composer.render()
  pipe.endFrame();                     // clear jitteru, snapshot ruchu, historia++

  requestAnimationFrame(loop);
}
```

Kontrakt klatki jest celowo trzylinijkowy: `beginFrame → render → endFrame`.
Cała reszta (kolejność passów, bufory, historia, resize) jest w środku.

Na resize: `pipe.setSize(cssWidth, cssHeight, devicePixelRatio)`.
Przy zmianie jakości/ustawień: `pipe.configure(tier, { taa, ao, dof, lut, photo })`.

---

## 2. Łańcuch passów

```
                 ┌── rozdzielczość WEWNĘTRZNA (renderScale · dpr) ──┐   ┌─ ekran ─┐
scene ─► RenderPass ─► VelocityPass ─► TemporalResolve ─► AO ─► DOF ─► Bloom ─► Output ─► Present ─► canvas
         (jitter,      (wektory ruchu   (historia +      (½ res) (bokeh) (glare) (ACES+sRGB) (CAS+LUT+
          HDR+depth)    obiektów dyn.)    clip wariancji)                                CA+vignette+grain)
```

| # | Pass | Rozdzielczość | Koszt | Co robi |
|---|------|---------------|-------|---------|
| 1 | `RenderPass` | wewnętrzna | scena | Rysuje scenę do RT **HalfFloat** z `DepthTexture`; kamera jest z jitterem sub-pikselowym. |
| 2 | `VelocityPass` | wewnętrzna | ~1 podzbiór draw-calli | Drugi rysunek **tylko** obiektów z warstwy `DYNAMIC_LAYER` z `overrideMaterial`, zapisuje `currentUv − previousUv` do RG16F. |
| 3 | `TemporalResolvePass` | wewnętrzna | 1 fullscreen (≈12 tapów) | Rekonstrukcja świata z deptha → reprojekcja `prevViewProj` → dla ruchomych pikseli wektory ruchu → **clip wariancji 3×3** → blend z historią (ping-pong). To jest temporalny upscaler. |
| 4 | `AmbientOcclusionPass` | **½** wewnętrznej + composite | 12 tapów + 5 tapów | AO liczone wyłącznie z deptha (normalne z pochodnych), spiralne próbki, potem bilateralny upsample świadomy głębokości. **Zero dodatkowych rysunków sceny.** |
| 5 | `DOFPass` | wewnętrzna | 12 tapów | Circle-of-confusion z deptha, gather po spirali, ważony CoC sąsiadów. Deliberately subtelne. |
| 6 | `UnrealBloomPass` | 0.5–0.6× wewnętrznej | mipy + blur | Fizycznie sensowna poświata/glare na wartościach HDR (przed tonemapem!). |
| 7 | `OutputPass` | wewnętrzna | 1 fullscreen | `ACESFilmicToneMapping` z `renderer.toneMappingExposure` + kodowanie sRGB. |
| 8 | `PresentPass` | **ekranu** | 1 fullscreen | CAS (sharpen z clampingiem), gradacja **LUT 3D 32³**, aberracja chromatyczna, radialny blur prędkości, winieta, ziarno. Tu następuje upscale do rozdzielczości wyświetlacza. |

Bufory: kompozytor ping-ponguje dwoma RT, a **depth sceny żyje tylko w `renderTarget1`** —
dlatego AO i DOF dostają teksturę głębokości jawnie (`setDepthTexture`), a nie z `readBuffer`.
Z tego samego powodu passy fullscreen mają wyłączony `autoClear`: `FullScreenQuad.render()`
przechodzi przez `renderer.render()`, który czyści też depth — a ten jest jeszcze potrzebny.

---

## 3. Dlaczego to wygląda „AAA / neural-photoreal”

Każdy etap dokłada jedną rzecz, której brakuje surowemu WebGL-owi:

1. **Skalowanie czasowe (TAA/TAAU) — serce triku.**
   Kamera dostaje co klatkę inny offset sub-pikselowy z *rotowanego Haltona (2,3)*
   (16 próbek, wyśrodkowany zbiór → zero systematycznego przesunięcia).
   `TemporalResolvePass` składa te próbki w jeden obraz: historia trzymana w buforze ping-pong
   HalfFloat jest **reprojekowana** (dla statyki z deptha, dla ruchu z wektorów ruchu),
   a przed blendem **przycinana do elipsoidy wariancji** sąsiedztwa 3×3. To dokładnie
   klasyczna (przed-neuronowa) droga, którą idą DLSS/FSR2/XeSS: zamiast 1× pikseli masz
   N× próbek w czasie. Waga historii jest malejąca z ruchem (`w = 0.93 / (1 + motionPx·0.45)`),
   więc szybkie obiekty nie smużą, a statyczne konwergują do czystego obrazu.
   Efekt uboczny: znikają „schodki” i migotanie cienkich geometrii (siatki, anteny, krawędzie neonów).

2. **Wektory ruchu (Velocity Pass).**
   Bez nich ruchome obiekty mają tylko reprojekcję z deptha, która nie wie, *co* się przesunęło —
   stąd ghosting na autach. Dlatego obiekty dynamiczne (auto gracza + ruch uliczny) trafiają na
   warstwę `DYNAMIC_LAYER` i są rysowane drugi raz z macierzą modelu z poprzedniej klatki
   (`userData.prevMW`). Ważne szczegóły:
   * velocity liczymy z **niez jitterowanej** projekcji (`unjitteredProj`) — wektor ma opisywać ruch,
     a nie offset próbki TAA;
   * obiekty instancjonowane, skórowane i przezroczyste są pomijane (ich macierz modelu nie opisuje
     ruchu per-instancja, a przezroczyste stożki świateł nadpisałyby ruch budynków za nimi) —
     te piksele wracają do reprojekcji z deptha, a clip wariancji pilnuje, żeby nie smużyły.

3. **Ambient Occlusion = cienie kontaktowe.**
   Największy „plastikowy” problem WebGPU/WebGL to brak okluzji: auto lewituje nad asfaltem,
   krawężniki nie mają styku. Nasze AO czyta wyłącznie depth (normalne z pochodnych `cross(dx,dy)`),
   robi 12 spiralnych tapów w **połowie** rozdzielczości i składa to bilineralnie z wagą głębokości.
   Mnożymy kolor *przed* tonemapem, więc okluzja tłumi światło, a nie „szarzeje obraz”.
   (Wbudowany `GTAOPass` odpada: robi pełny prepass normalny = dodatkowy rysunek całej sceny.)

4. **ACES + ekspozycja.**
   `ACESFilmicToneMapping` w `OutputPass` zwija highlightsy (neony, reflektory) filmowo zamiast
   obcinać je do bieli, a `toneMappingExposure` działa jak czas naświetlania. Cała scena jest
   liczona w liniowym HDR (`HalfFloatType`), więc bloom i AO pracują na fizycznych wartościach.

5. **Gradacja LUT 3D (profil „Naturalny”).**
   LUT 32³ generowany proceduralnie w przestrzeni *display-referred* (po tonemapie) — tak jak w
   kinie: krzywa S (kontrast), split-toning (chłodne cienie / ciepłe światła), desaturacja ~10%,
   **toe** (lekko podniesiona czerń) i **shoulder** (rolled-off biel) aplikowane na końcu, żeby
   tinty nigdy nie wypchnęły bieli z powrotem do 1.0. Profil `film` = teal & orange,
   `vivid` = stary neonowy look gry, `none` = czysty ACES.
   LUT jest **half-float (RGB16F)**, nie 8-bitowy i nie float32: 8 bitów bandinguje w ciemnych
   gradientach nocy, a float32 wymaga `OES_texture_float_linear` do filtrowania trylinearnego
   (brak tego rozszerzenia na części mobilnych GPU = niezdefiniowane próbkowanie). Half-float
   filtruje się w WebGL2 w standardzie i daje ~2048 stopni w [0,1] (błąd kwantyzacji ≤2.4e-4).
   Mikro-kontrast celowo *nie* siedzi w LUT-cie (LUT nie widzi sąsiadów) — robi go CAS.

6. **CAS (Contrast Adaptive Sharpening) w `PresentPass`.**
   To „present/upscale” etap temporalnego potoku: wyostrzenie z **clampingiem do lokalnego
   min/max**, czyli bez ringing halo wokół neonów. Przy `renderScale 0.7` to ono oddaje
   szczegół, który inaczej rozmyłby się przy upscale’u.

7. **Glare, nie „bloom z gierki”.**
   `UnrealBloomPass` startuje z wartości HDR *przed* tonemapem i z progiem 0.8, więc świecą tylko
   prawdziwe źródła światła; mip-chain daje szeroką, miękką poświatę (halogeny, mokry asfalt).

8. **Obiektyw, nie ekran.** Aberracja chromatyczna rosnąca ku krawędziom, radialny blur prędkości
   (od ~80 km/h), winieta, drobne ziarno filmu — wszystko w jednym passie na rozdzielczości ekranu.
   W trybie foto: pełna rozdzielczość wewnętrzna, głębsza winieta, +25% bloom, więcej ziarna.

9. **IBL / PMREM.** `scene.environment` jest wypalane z miasta `PMREMGenerator.fromScene`
   (dodatkowo dedykowana scena „night city studio” dla lakieru clearcoat) — odbicia w lakierze,
   chromie i szybach mają skąd brać energię, więc PBR nie jest czarny.

10. **Cienie.** Domyślnie `PCFSoftShadowMap` + `bias −0.0006` / `normalBias 0.4` i cache’owana mapa
    (`shadowMap.autoUpdate = false`, odświeżana raz na klatkę — pass odbić jej nie re-renderuje).
    Opcjonalnie **VSM** (ustawienie „Cienie” w menu): separowalny blur mapy daje bardzo miękką
    półcienistość; wymaga mniejszego biasu (`−0.00012`, `normalBias 0.6`) i zmiany typu mapy
    w locie (stara mapa jest dysponowana, bo VSM potrzebuje formatu float).

---

## 4. Profile i budżet

`PIPE_PROFILES` w `src/render/Pipeline.js`:

| Tier | renderScale | TAA | Wektory ruchu | AO | DOF | MSAA (gdy TAA off) | Bloom |
|------|-------------|-----|---------------|----|-----|--------------------|-------|
| 0 NISKA   | 1.00 | – | – | – | – | – | 0.50 |
| 1 ŚREDNIA | 1.00 | – | – | – | – | – | 0.62 |
| 2 WYSOKA  | 0.85 | ✅ | – | ✅ | – | 4× | 0.75 |
| 3 ULTRA   | 0.70 | ✅ | ✅ | ✅ | ✅ | 4× | 0.85 |

Zasada: **albo TAA, albo MSAA.** Przy włączonym skalowaniu czasowym jitter już pokrywa krawędzie,
więc MSAA to czysta strata przepustowości (i pamięci na resolve deptha). Wyłączenie TAA w menu
automatycznie wraca do `renderScale 1.0` + MSAA z tieru — obraz nigdy nie jest jednocześnie
miękki i postrzępiony.

Przełączniki użytkownika (menu → ✨ Grafika → *Potok renderowania*): skalowanie czasowe, AO, DOF,
profil kolorystyczny, tryb cieni. Wszystkie zapisują się w `localStorage` i przebudowują łańcuch
bez przeładowania strony (passe są tworzone raz i używane ponownie — realokowane są tylko RT).

---

## 5. Jak trzymać stabilny FPS — konkrety

**Rozdzielczość (największa dźwignia)**
1. `renderScale 0.7–0.85` przy TAA: 0.7² = **~2× mniej pikseli** do cieniowania niż natywne 1.0,
   a obraz ostrzejszy niż natywne 0.7 bez rekonstrukcji. To jest ten „darmowy” FPS.
2. Nigdy nie płać podwójnie za AA: TAA ⇒ `samples = 0`. MSAA 4× na HalfFloat z resolve’m deptha
   to realnie kilka milisekund na mobile.
3. `pixelRatio` capuj (`min(devicePixelRatio, 2)`), a na słabych GPU schodź niżej —
   `QualityManager.resScale` mnoży dpr adaptacyjnie.
4. AO liczymy w **połowie** rozdzielczości, bloom w **0.5–0.6×** — oba efekty są niskoczęstotliwościowe,
   więc nikt nie widzi różnicy, a fill-rate spada ~4×.
5. Tryb foto wymusza `renderScale 1.0` (zrzut ma być ostry), ale tylko na czas foto.

**Draw-calle i CPU**
6. Velocity Pass rysuje **tylko warstwę dynamiczną** (kilkanaście meshy), nie całą scenę —
   koszt to ~1 dodatkowy draw na obiekt ruchomy, a nie druga scena.
7. Wszystko co się da w `InstancedMesh` (budynki, okna, latarnie, pierścienie, ślady opon).
8. Cienie: `shadowMap.autoUpdate = false` + `needsUpdate = true` raz na klatkę —
   pass odbić planarnych nie renderuje mapy cieni drugi raz.
9. `scene.environment` wypalane **raz** na starcie (PMREM), nie co klatkę.
10. HUD na canvasie 2D rysujemy co 2/3/4 klatkę (prędkościomierz / minimapa / punkty) —
    to czysty koszt CPU, którego nie widać przy 60 FPS.
11. Zero alokacji w pętli: tymczasowe `Vector3/Matrix4` są współdzielone, a passy i LUT-y
    tworzone raz (przebudowa łańcucha realokuje tylko RT).

**Pamięć / przepustowość**
12. `HalfFloatType` (nie `FloatType`) dla HDR — połowa przepustowości, wystarczy zakresu.
13. LUT 32³ RGB16F = 256 KB raz na profil (cache’owany per nazwa profilu, bez mipmap).
14. Historia TAA to 2× RT w rozdzielczości wewnętrznej — dlatego przy zmianie rozmiaru okna
    wołamy `resetHistory()` (inaczej reprojekcja czyta bufor o innym rozmiarze).

**Co robić, gdy FPS siada**
15. `QualityManager` już mierzy FPS z histerezą i cooldownem i zrzuca tier (a na końcu `resScale`).
    Kolejność cięcia kosztów: DOF → AO → `renderScale` (TAA zostaje — to ono daje FPS) → tier.
16. Sprawdź panel wydajności (`G`): draw-calle, trójkąty, rozdzielczość wewnętrzna i aktywne efekty
    są wypisane wprost, więc widać, co kosztuje.

---

## 6. Weryfikacja bez przeglądarki

W tym repo nie ma headlessowego WebGL, więc potok jest testowany trzema warstwami:

```bash
npm test                       # logika: jitter (wyśrodkowany Halton 2,3), LUT 32³, profile,
                               # kontrakt begin/endFrame na stub-rendererze
npx eslint src/                # styl + nieużywane/unify
npx vite build                 # bundling
npm run test:glsl            # GLSL ES 3.00: kompilacja + LINK + cross-check uniformów
```

`test/shaders.mjs` odtwarza prefiks, który Three.js dokleja do `ShaderMaterial` na WebGL2
(`#version 300 es`, `#define varying in/out`, `#define texture2D texture`, `pc_fragColor`)
i przepuszcza każdy shader potoku przez `glslangValidator` — osobno vertex, osobno fragment
oraz **z linkowaniem** (`-l`), które łapie niezgodne varying. Dodatkowo porównuje uniformy
zadeklarowane w GLSL z kluczami w `material.uniforms`, więc literówka w nazwie uniforma
(zamiast cichego `0`) wywala test.

```bash
npm i --no-save glslang-validator-prebuilt-predownloaded   # ~7 MB, nie wchodzi do package.json
chmod +x node_modules/glslang-validator-prebuilt-predownloaded/bin/glslangValidator.linux
npm run test:glsl
```

Bez binarki skrypt kończy się czystym pominięciem (exit 0), więc `npm run test:glsl` jest
bezpieczny w CI i na świeżym klonie.

---

## 7. Znane ograniczenia

* **Instancje bez wektorów ruchu** (pierścienie, ślady opon, deszcz) — ich ruch pokrywa
  reprojekcja z deptha + clip wariancji; przy bardzo szybkim obrocie kamery mogą przez klatkę mignąć.
* **AO z samego deptha** nie widzi cienkiej geometrii „na krawędzi” (druty, barierki) i nie ma
  normali materiałowej — to świadomy kompromis: 0 dodatkowych rysunków sceny zamiast prepassu GTAO.
* **TAA a przezroczystości**: addytywne stożki świateł i neony z alpha nie mają wektorów ruchu,
  więc historia jest dla nich trzymana krócej (clip wariancji reaguje na ich zmianę).
* **VSM** bywa widocznie „przeciekający” na cienkich elementach (barierki, anteny) — dlatego
  domyślnie jest PCF Soft, a VSM to opcja.
* History TAA jest kasowana przy resize, zmianie tieru i wejściu/wyjściu z trybu foto
  (pierwsza klatka po zmianie jest czystym renderem bez rekonstrukcji).
