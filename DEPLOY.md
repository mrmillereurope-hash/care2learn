# Deploying Care2Learn to Render

This guide takes the `care2learn-backend` folder from files on your computer to a
live website with a real database. No command line is required — everything is
done through the GitHub and Render websites.

There are three stages: **(A)** put the code on GitHub, **(B)** create the Render
Web Service, **(C)** add the database disk so data is saved permanently.

---

## Stage A — Put the code on GitHub

Render reads your code from a GitHub repository, so this step has to happen first.

1. Go to **github.com** and sign up for a free account (or sign in).
2. Click the **+** in the top-right corner and choose **New repository**.
3. Give it a name, e.g. `care2learn`. Leave it set to **Private**. Click
   **Create repository**.
4. On the next page, click the link **"uploading an existing file"**
   (in the line "…or push an existing repository / upload an existing file").
5. Open the `care2learn-backend` folder on your computer. Select **all the files
   and the `public` folder inside it** and drag them into the GitHub upload area.
   You should be uploading: `package.json`, `server.js`, `db.js`, `courses.js`,
   and the `public` folder (which contains `index.html` and `app.js`).
   - Do **not** upload the `data` folder if one exists — that's just the local
     database and isn't needed.
6. Click **Commit changes**. Your code is now on GitHub.

---

## Stage B — Create the Render Web Service

1. At **render.com**, sign in (you can sign in with your GitHub account).
2. Click **New** → **Web Service**.
3. On the "Source Code" step, choose **Git Provider → GitHub**, authorise Render
   to access GitHub if asked, then select your **care2learn** repository.
4. On the configuration screen, set:
   - **Name:** anything you like (this becomes part of the web address).
   - **Region:** choose the one closest to you (e.g. Frankfurt or London for the UK).
   - **Branch:** `main`.
   - **Runtime / Language:** Node (Render usually detects this automatically).
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** see the note below about Free vs paid.
5. Click **Create Web Service**. Render will build and start your app, then give
   you a live URL like `https://care2learn.onrender.com`.

**Free vs paid:** A **Free** instance is fine to confirm everything works, but on
the Free tier the database is wiped whenever the service restarts or goes to
sleep, and the site sleeps after 15 minutes of inactivity (taking ~1 minute to
wake up). For real use where data must be kept, choose the **Starter** instance
(around $7/month) and complete Stage C.

---

## Stage C — Add the database disk (so data is saved permanently)

This is what makes registrations, staff, progress and certificates persist.
It requires a paid (Starter or higher) instance.

1. In your service on Render, open the **Disks** section (under Settings, or via
   "Advanced" during creation).
2. Click **Add Disk** and set:
   - **Name:** `data`
   - **Mount Path:** `/var/data`
   - **Size:** 1 GB is plenty to start.
3. Open the **Environment** section and add an environment variable:
   - **Key:** `DATA_DIR`
   - **Value:** `/var/data`
4. Save. Render redeploys automatically. From now on, all data is written to the
   disk and survives restarts and future updates.

---

## Logging in once it's live

The demo accounts still work on the live site:

- **Organisation:** `demo@care2learn.co.uk` / `demo123`
- **Staff:** `priya@demo.com` / PIN `9012`

You can also register a brand-new organisation from the live site and start
adding your own staff and courses.

---

## Pointing your GoDaddy domain at it (optional, later)

Once you're happy with the Render URL, you can make the site appear at your own
GoDaddy domain:

1. In Render, open your service's **Settings → Custom Domains** and add your
   domain. Render will show you the DNS records to create.
2. In your GoDaddy account, open **DNS Management** for your domain and add the
   records exactly as Render specifies (usually a CNAME, or an A record).
3. Wait for it to verify (can take from minutes to a few hours). Render issues a
   free SSL certificate automatically so the site loads over https.

---

## Updating the site later

When you want to change anything, you don't redo all of this. Upload the changed
file(s) to the same GitHub repository (via the website, same as Stage A), and
Render automatically rebuilds and redeploys within a minute or two.

---

## A note on the database driver

`package.json` lists `better-sqlite3` as an optional dependency. On Render's
servers it installs automatically and is used for the database. If it ever fails
to install, the app automatically falls back to Node's built-in SQLite, so the
deploy still succeeds either way.
