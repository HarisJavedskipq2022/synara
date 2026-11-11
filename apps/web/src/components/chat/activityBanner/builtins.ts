// FILE: builtins.ts
// Purpose: The built-in landscape artwork for the activity banner, as inline SVG data URLs.
// Layer: Chat shell data
// Exports: BUILTIN_BANNERS, BuiltinBannerId
//
// Artwork ported from Arbor Classic's features/thread/banners/builtins.ts.

/** Original landscape artwork made for Arbor. No external assets, characters or lettering. */
function landscape(top: string, bottom: string, art: string): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient><radialGradient id="glow"><stop stop-color="#fff5d6" stop-opacity=".7"/><stop offset="1" stop-color="#fff5d6" stop-opacity="0"/></radialGradient></defs><path fill="url(#sky)" d="M0 0h640v360H0z"/>${art}</svg>`)}`;
}

export const BUILTIN_BANNERS = [
  {
    id: "crimson-dusk",
    nameKey: "chat:banner_crimsonDusk",
    src: landscape(
      "#291d50",
      "#fc8959",
      `
      <circle cx="447" cy="136" r="130" fill="url(#glow)"/><circle cx="447" cy="136" r="55" fill="#ffdf9d"/>
      <path d="M0 72 163 55 270 69 136 79zm355-26 168-18 117 12-202 17z" fill="#fa9b9c" opacity=".45"/>
      <path d="m0 268 110-122 99 95 95-75 102 92 90-63 144 70v95H0" fill="#734461"/>
      <path d="m0 306 134-94 118 102 122-89 132 99 134-62v98H0" fill="#302b49"/>
      <path d="m0 337 157-32 160 38 152-25 171 17v25H0" fill="#191d35"/>
      <g stroke="#ffd1a5" opacity=".4"><path d="m20 119 210-20m-185 42 114-11m342 101 125-12"/></g>`,
    ),
  },
  {
    id: "moon-shrine",
    nameKey: "chat:banner_moonShrine",
    src: landscape(
      "#111f48",
      "#776994",
      `
      <circle cx="425" cy="105" r="122" fill="url(#glow)"/><circle cx="425" cy="105" r="57" fill="#e0e7ef"/>
      <path d="m0 239 142-82 99 90 110-63 113 67 176-104v213H0" fill="#424969"/>
      <path d="m0 294 133-53 153 68 123-37 231 31v57H0" fill="#252d4d"/>
      <g fill="#141d36"><path d="M143 188h13v138h-13zm114 0h13v138h-13z"/><path d="m109 183 97-17 99 17-15 13H123zm19 33h158v10H128z"/>
      <path d="m0 318 640 17v25H0z"/></g><path d="m333 300 146 2-26 5-123-2zm-19 21 194 2-39 5-153-2z" fill="#a5a4be" opacity=".5"/>
      <g fill="#c7d6ed"><circle cx="77" cy="67" r="2"/><circle cx="189" cy="99" r="1.5"/><circle cx="548" cy="47" r="2"/></g>`,
    ),
  },
  {
    id: "storm-sky",
    nameKey: "chat:banner_stormSky",
    src: landscape(
      "#171c42",
      "#687e9c",
      `
      <path d="M0 59 123 39 223 86 344 46 465 63 550 30 640 67v77l-116-23-127 26-148-15-132 27L0 126z" fill="#30395d"/>
      <path d="m0 165 166-37 110 38 117-24 125 20 122-33v49l-126 15-131-17-109 18-154-24L0 190z" fill="#8c9cad" opacity=".5"/>
      <path d="m423 42-79 124h52l-83 133 137-153h-60l67-104" fill="#accbe8" opacity=".25" stroke="#accbe8" stroke-width="14"/>
      <path d="m423 42-79 124h52l-83 133 137-153h-60l67-104" fill="#effaff"/>
      <path d="m0 290 114-82 139 99 116-57 121 55 150-75v130H0" fill="#252d49"/>
      <g stroke="#ccdced" opacity=".35"><path d="m77 120-37 76m120-84-63 128m454-115-64 128m128-144-70 141M291 34l-29 58"/></g>`,
    ),
  },
  {
    id: "petal-wind",
    nameKey: "chat:banner_petalWind",
    src: landscape(
      "#6a7db3",
      "#fbc5c8",
      `
      <path d="m0 87 123-14 147 21-87 16L0 107zm281 46 194-21 165 15v19l-196-7z" fill="#fce0df" opacity=".65"/>
      <path d="m0 263 102-61 128 64 147-79 116 95 147-64v142H0" fill="#a292b7"/>
      <path d="m0 310 123-46 158 60 192-44 167 31v49H0" fill="#55587f"/>
      <path d="M21 360 53 202 36 108 3 57l53 45 26 69 78-53 68-15-63 32-71 73-38 152z" fill="#3c355b"/>
      <g fill="#f6b4ce"><path d="M0 85Q78 17 152 52T252 96Q153 125 0 121z"/>
      <path d="M91 161q31-45 91-37t77 34q-86 32-168 3"/>
      <path d="M360 177q22-24 34-9-11 26-34 9m155-74q24-16 30 1-19 19-30-1m-88 165q15-27 31-14-7 25-31 14m-132-48q20-15 27 3-19 16-27-3m273 49q26-14 29 3-21 16-29-3"/></g>
      <g fill="none" stroke="#fff0ed" opacity=".5"><path d="M186 203q180-63 454-27M265 238q206-48 375-20"/></g>`,
    ),
  },
  {
    id: "ember-blade",
    nameKey: "chat:banner_emberBlade",
    src: landscape(
      "#241d35",
      "#cc573c",
      `
      <path d="m0 208 87-36 123 38 120-46 157 63 153-62v195H0" fill="#633247"/>
      <path d="m0 283 135-49 120 70 155-66 230 40v82H0" fill="#302235"/>
      <path d="m82 360 87-126 40 34 54-97 41 27 50-94 26 75 45-44 19 126 64-20 50 119" fill="#f09a54" opacity=".22"/>
      <path d="m226 335 157-210-131 229z" fill="#ffe0b1"/><path d="m226 335 21 10 136-220z" fill="#ee8654"/>
      <path d="m207 317 65 43h-29l-47-31z" fill="#211f32"/>
      <g fill="#ffbf6e"><path d="m113 230 6-16 4 14-6 9zm324-44 6-21 6 17-5 10zM478 76l5-15 5 11-6 12zM198 133l4-17 7 14-6 9zM551 244l7-20 2 16-6 11z"/></g>
      <g stroke="#f5a46c" opacity=".5"><path d="m54 290 117-171m297 160 98-149M344 92l31-48"/></g>`,
    ),
  },
] as const;

export type BuiltinBannerId = (typeof BUILTIN_BANNERS)[number]["id"];
