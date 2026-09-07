# בקרה — ט.ש. מי-רון

אפליקציית PWA לבקרת ביצוע ומלאי בפרויקטי אינסטלציה. אתר סטטי בלבד — אין שרת, אין build.
שלוש פרסונות: **סמנכ״ל ביצוע** (מבט על), **שטח** (דיווח + צ׳קליסטים), **מחסן** (אישורי ניפוק + ניוד מלאי).

הנתונים נשמרים מקומית בדפדפן של כל מכשיר (`localStorage`). כפתור ↺ מאפס לנתוני הבסיס.
31 הפרויקטים אמיתיים; שלבים/מלאי/אחראים הם נתוני הדגמה עד לחיבור דיווחי שטח.

## מבנה

```
index.html               האפליקציה (React + htm, ללא build)
manifest.webmanifest      שם "בקרה", אייקונים, צבע נושא
sw.js                     service worker — עבודה אופליין
vendor/                   React / htm מקומיים (לא CDN)
icons/                    אייקוני מסך בית (192/512, כולל maskable)
apple-touch-icon.png      אייקון אייפון
favicon.ico, favicon-*.png
.nojekyll                 נדרש ל-GitHub Pages
```

## הרצה מקומית

חובה דרך שרת (service worker לא רץ מ-`file://`):

```bash
cd bakara-app
python3 -m http.server 8080
```

פתח `http://localhost:8080`.

## פריסה

### GitHub Pages
1. צור repo חדש, העלה את תוכן התיקייה לשורש (`index.html` בשורש).
2. Settings → Pages → Branch: `main` / root → Save.
3. הכתובת: `https://<user>.github.io/<repo>/`.

### Netlify / Vercel
גרור את התיקייה ל-Netlify Drop (`app.netlify.com/drop`), או `vercel` בתיקייה. אין הגדרות build.

### דומיין משלך
העלה את כל הקבצים לשורש הדומיין (או תת-נתיב). ה-`start_url` וה-`scope` יחסיים ולכן עובדים בכל נתיב.

> חובה HTTPS (או localhost) כדי ש-service worker וההתקנה יעבדו. GitHub Pages / Netlify / Vercel מספקים HTTPS אוטומטית.

## התקנה במכשיר

- **אייפון (Safari):** שיתוף → "הוסף למסך הבית". יופיע האייקון הכחול והשם **בקרה**.
- **אנדרואיד (Chrome):** תפריט → "התקנת אפליקציה" / "הוספה למסך הבית".

## עדכון גרסה

אחרי כל שינוי בקובץ מקבצי ה-shell — הגדל את `CACHE` ב-`sw.js` (למשל `bakara-v2`) כדי שמכשירים שכבר התקינו יקבלו את הגרסה החדשה.
