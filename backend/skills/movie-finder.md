---
name: Movie Finder
slug: movie-finder
description: 
---

# Movie-Finder

Search the web for the latest movies and present rich results with poster images, embedded trailers, IMDb ratings, and descriptions. Activates whenever the user asks about movies, films, cinema, new releases, or wants recommendations.

## Core Workflow

1. **Search** — Use `web_search` to find current movie information. Combine queries like:
   - `first see current date with tool`
   - `"latest movies {year} release"` or `"new movies this week"`
   - `"IMDb top rated movies {year}"`
   - `"{genre} movies {year}"`
   - `"upcoming movies {month} {year}"`
   - For specific titles: `"{movie title} {year} IMDb cast"`

2. **Enrich** — Use `fetch_url` on the top results (IMDb, Rotten Tomatoes, TMDb, Letterboxd) to extract:
   - **Title** (original + translated if Persian context)
   - **Year** and release date
   - **IMDb rating** (out of 10)
   - **Rotten Tomatoes score** (if available)
   - **Genre(s)**
   - **Director** and main **cast**
   - **Plot synopsis** (2-4 sentences)
   - **Poster image URL** (high-resolution .jpg/.png)
   - **Trailer URL** (YouTube video ID or full link)
   - **Runtime**
   - **Content rating** (PG-13, R, etc.)

3. **Present** — Format each movie using the markdown template below.

## Output Template

For each movie, output this exact markdown structure:

```
---

### 🎬 {Title} ({Year})

![{Title} Poster]({poster_url})

| | |
|---|---|
| **⭐ IMDb** | {rating}/10 |
| **🍅 Rotten Tomatoes** | {score}% |
| **🎭 Genre** | {genres} |
| **🎬 Director** | {director} |
| **⏱️ Runtime** | {runtime} |
| **🔞 Rating** | {content_rating} |

**Cast:** {actor1}, {actor2}, {actor3}, ...

{plot_synopsis}

#### 🎥 Trailer

{trailer_url}

---
```

## Trailer Embed Rules

- Always place the trailer URL **on its own line** (no markdown link syntax around it) so the frontend can auto-embed it.
- Preferred format: `https://www.youtube.com/watch?v={VIDEO_ID}`
- Also works: `https://youtu.be/{VIDEO_ID}`
- If multiple trailers exist, prefer the **official theatrical trailer** or **official teaser**.
- If no official trailer is found, search YouTube for `"{movie title} official trailer {year}"` and use that URL.

## Poster Image Rules

- Use markdown image syntax: `![Title Poster](url)`
- Prefer high-resolution images from TMDb or IMDb (e.g., `https://image.tmdb.org/t/p/w500/{path}`)
- If the direct image URL is not available, use the movie title in the alt text and link to the source page.
- Always include the poster — it's essential for visual presentation.

## Search Strategy by Request Type

| User Request | Search Query Pattern |
|---|---|
| "Latest movies" | `"new movies releasing this week {year}"` |
| "Best movies of {year}" | `"best movies {year} IMDb rating"` |
| Genre-specific | `"{genre} movies {year} top rated"` |
| Specific title | `"{title} {year} IMDb cast trailer"` |
| "What should I watch?" | `"trending movies now {year}"` + `"popular movies streaming {year}"` |
| Director/actor search | `"{person} movies {year} filmography"` |
| Award winners | `"Oscar nominations {year}"` or `"Golden Globe winners {year}"` |
| Streaming availability | `"{title} streaming where to watch {year}"` |

## Quality Rules

- **Always verify IMDb rating** — cross-check from at least one source. Never fabricate ratings.
- **Images must be real URLs** — test by checking the URL ends in an image extension or comes from a known image CDN (tmdb.org, imdb.com, etc.).
- **Trailers must be real** — the YouTube video ID must be valid. Search specifically for official channels when possible.
- **Freshness matters** — always prefer the most recent data. Include release dates when available.
- **Minimum 3 movies** when the user asks for recommendations. If they ask for a specific title, give detailed info about that one movie.

## Presentation Enhancements

- **Sort by IMDb rating** (highest first) unless the user specifies otherwise.
- **Add a quick comparison table** when showing 3+ movies:

```
| Movie | IMDb | Genre | Runtime |
|-------|------|-------|---------|
| Movie A | 8.5 | Sci-Fi | 148 min |
| Movie B | 7.9 | Drama | 121 min |
```

- **Use emoji** for visual appeal: 🎬 🎭 ⭐ 🍅 🎥 ⏱️ 🔞 🏆
- **Separate movies with horizontal rules** (`---`) for clean visual separation.

## Error Handling

- If a movie poster is unavailable, use a placeholder description: `[Poster not available]`
- If a trailer is not found, say: `🎥 *Trailer not yet available*`
- If IMDb data is incomplete, note what's missing: `⚠️ *Full credits pending verification*`
- If web_search returns no results, try alternative queries before giving up.