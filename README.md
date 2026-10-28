# TOEFL Vocab Trainer

A small web app for memorizing TOEFL vocabulary with flashcards, synonyms, antonyms,
example sentences and quizzes. It is plain HTML/CSS/JavaScript: no build step,
no server and no account. Your words are saved in your browser.

## Features

- **Notebook words**: ~1,000 words from my handwritten notebook (`data/notebook-words.js`, pages 1–41) with their
  synonyms and Arabic meanings are loaded into My Words. Words added to that file later are
  picked up automatically, without bringing back words you deleted.
- **My Words**: add words one at a time or bulk-import your list (paste, or a `.txt`/`.csv` file).
  Empty fields (definition, part of speech, synonyms, antonyms, examples) can be
  **auto-filled** from free online dictionaries.
- **Flashcards** with spaced repetition. Rate each card *Again / Hard / Good / Easy* and the app
  schedules it for later (Leitner boxes: 1, 2, 4, 7, 15 and 30 days). The back of the card shows
  the definition, Arabic meaning, synonyms, antonyms and example sentences with the word highlighted,
  plus 🔊 pronunciation. Sessions are 30 cards long.
- **Quiz**: pick the synonym, pick the antonym, word from definition, word from Arabic meaning,
  or complete the sentence.
  Words you miss come back as due in Flashcards.
- **Extra Words**: a separate deck for extra practice, so it never mixes with your own list.
  - *Add from TOEFL word list*: random words from a built-in list of ~200 academic words.
  - *Add words related to my list*: finds related academic words online, based on your own words.
  - Move any extra word into My Words with one click.
- **Data**: progress stats (mastered, due, streak, accuracy) and JSON backup/restore.

Keyboard shortcuts: `Space` flips a card, `1`–`4` rate it or pick a quiz answer, `Enter` moves to the next question.

## Import format

One word per line, optionally followed by fields separated by `|`:

```
ubiquitous
meticulous | showing great attention to detail | careful, precise | careless, sloppy | She kept meticulous notes. | شديد الحرص
```

The CSV format uses the same columns: `word, definition, synonyms, antonyms, example, arabic`.
Separate multiple synonyms/antonyms inside a quoted cell with `,` or `;`. A header row is optional.

## Running it

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Using it on an iPhone

The app is a Progressive Web App: once it is hosted at a web address you can install it
on the Home Screen and it runs full screen, like a regular app, and works offline.

1. Host the folder, e.g. with **GitHub Pages**: put these files at the root of a repository,
   then Settings → Pages → Deploy from a branch → `main` / `(root)`. GitHub shows the address,
   e.g. `https://<username>.github.io/<repo>/`.
2. Open that address in **Safari** on the iPhone.
3. Tap **Share** → **Add to Home Screen** → **Add**.
4. Open it from the Home Screen icon from then on.

Your words and progress are saved on the phone. Open the app from the Home Screen icon rather
than a Safari tab: Safari may clear a website's saved data after a week without visits, but not
the data of Home Screen apps. Use **Data → Export backup** now and then to keep a copy.

## Data sources

- [Free Dictionary API](https://dictionaryapi.dev): definitions, parts of speech, examples, synonyms and antonyms
- [Datamuse API](https://www.datamuse.com/api/): synonyms, antonyms and related words

Both are free and need no API key. Without internet access the app still works with the
details you typed in yourself.

## Files

```
index.html            page layout
styles.css            styling (light and dark mode)
app.js                all app logic
data/toefl-words.js   built-in pool of TOEFL words for the Extra deck
data/notebook-words.js  my notebook words (word | synonyms | antonyms | Arabic | example)
manifest.json         Home Screen app settings (name, icon, colors)
sw.js                 service worker: lets the app work offline
icons/                app icons
```
