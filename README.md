# Paradigm Reboot Score Tool

## Project Description

Paradigm Reboot Score Tool is a simple web tool that helps Paradigm game players calculate scores and view song lists. The project is built with pure HTML, CSS, and JavaScript, without using any frameworks.

## Main Features

### 1. Score Calculator

- Calculate scores based on song, difficulty, and achieved score
- Display corresponding rank and points
- Search for songs with automatic suggestions
- Supports 4 difficulties: Reboot, Massive, Invaded, Detected

### 2. Song List

- Display list of all songs in the game
- Search songs by name
- Filter by difficulty
- Pagination with 36 songs per page
- Display detailed information: cover, artist, BPM, album, notes

## Project Structure

```
paradigm_reboot_tool/
├── paradigm-score.html    # Main HTML file
├── script.js              # JavaScript logic
├── style.css              # Stylesheet
└── asset/
    └── rank/              # Directory containing rank images
```

## How to Use

1. Open `paradigm-score.html` in a web browser
2. Use the menu to switch between Score Calculator and Song List
3. In Score Calculator:
   - Enter song name (with automatic suggestions)
   - Select difficulty
   - Enter score (0-1010000)
   - Click Calculate to view results
4. In Song List:
   - Use the search box to find songs
   - Check boxes to filter by difficulty
   - Click on a song to view details

## API Used

The project uses the API from `https://api.prp.icel.site/api/v1/songs` to fetch song data.

## System Requirements

- Modern web browser with JavaScript support
- Internet connection to load data from API

## Development

The project is developed for the Paradigm player community. The source code is open and can be further improved.

## Author

The project is created by the Paradigm player community.

## License

This project has no specific license. Use for personal purposes.
