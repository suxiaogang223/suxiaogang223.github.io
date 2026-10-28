---
title: Build a Free Photography Website with GitHub Pages
summary: Start with a GitHub account and a few favorite photos, then let an AI coding assistant help you build your own website. Includes a prompt you can copy and the limits of this free setup.
---

I've been taking more photos lately: street scenes, trips, and a few rolls of film. I wanted somewhere to put them together, choose a cover, arrange the sequence, and write a little about each outing.

That's how my photography site, [目光所及](https://suxiaogang223.github.io/photography/), came about.

<figure>
  <a href="/assets/images/github-pages-photography/home.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/github-pages-photography/home.webp" width="1280" height="1220" alt="The dark homepage of my photography website, featuring a giraffe photograph from the zoo series" loading="lazy" decoding="async" /></a>
  <figcaption>My photography homepage. The cover, series, and introduction can all be replaced with your own.</figcaption>
</figure>

You can browse by series or open a photo for a closer look. Film photos have their own borders, with the camera, film stock, and date recorded alongside them. I also added a “Photo Print” feature: it puts a paper border around a photo you like and lets you save it as a JPEG.

I haven't rented a server or paid for image storage. The website and its resized photos live on GitHub, and GitHub Pages makes them available on the web.

If you'd like a site like this, you can ask an AI coding assistant to work from [my project](https://github.com/suxiaogang223/photography). You don't have to write the code yourself. Whenever you need to do something on your computer, ask it to walk you through that step.

## Step 1: Create a GitHub account

**Do this first. Your website and photos will live under your own GitHub account.**

Open the [GitHub sign-up page](https://github.com/signup), follow the instructions, and verify your email address. Give your username a little thought: it will usually be part of your website address.

For example, if your username is `xiaoming`, your photography site could be:

```text
https://xiaoming.github.io/photography/
```

Creating the account is free, and you don't need to buy this website address.

GitHub is a place where people store code and work on it together. For this tutorial, think of it as somewhere to keep your website files. A “repository” is like a folder for the project. GitHub Pages turns those files into a website other people can visit.

You can learn the terminology as you go. The important part is that **you use your own account and keep the website there.**

## Step 2: Choose a small set of photos

Pick a dozen or so favorites and put them in a folder on your computer. You can add the rest later.

If your photos are in Apple Photos, export them to your computer first. JPEG is a convenient choice. Group them into folders by subject, such as “A Walk by the Sea” or “A Few Days Back Home.” Each folder can become a series.

Have a few words ready about yourself, too: the site's name, the name you'd like to use, and what you enjoy photographing. You can also choose a portrait for the About page.

Keep the originals in your photo library or on your drive. The website uses resized, compressed copies so the pages load faster and take up less space.

## Step 3: Ask AI to help you build it

Use an AI coding assistant that can read project files, edit them, and run programs on your computer. A regular chat window can explain what to do, but if it can't work with your files, you'll need to copy the code and run the commands yourself. An assistant with those tools makes the process easier for a beginner.

Give it the prompt at the end of this article and tell it where your photos are. The reference project is:

[suxiaogang223/photography](https://github.com/suxiaogang223/photography)

You can keep the existing design at first and replace the name, photos, and introduction. Once it's working, take your time with the colors, typefaces, and layout.

<figure>
  <a href="/assets/images/github-pages-photography/lightbox.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/github-pages-photography/lightbox.webp" width="1280" height="720" alt="A full-frame film photograph of a green lake in the lightbox, with camera, film stock, and capture date shown below" loading="lazy" decoding="async" /></a>
  <figcaption>The lightbox keeps the whole photograph in view and shows its shooting details.</figcaption>
</figure>

If you need to install something, sign in, or click a button on GitHub, ask the assistant for just the next step. If something goes wrong, send it the error message. You don't have to work out the cause on your own.

Enter passwords and email verification codes yourself. You don't need to send them to the assistant.

## Step 4: Preview it, then publish

First, ask the assistant to open a preview on your computer. At this point, other people won't be able to visit it through a public address.

Describe changes the way you'd normally say them:

> Use the third photo as the cover for the seaside series. Keep the portrait photos upright, and show the most recently photographed series first.

Check that all the photos are there, the order feels right, and the name and introduction are yours. Try opening a photo and using “Photo Print,” too.

<figure>
  <a href="/assets/images/github-pages-photography/print.webp" target="_blank" rel="noopener noreferrer"><img src="/assets/images/github-pages-photography/print.webp" width="1280" height="720" alt="The Photo Print preview adds a warm paper border and shooting details to a photograph of a lake at Erdaohai" loading="lazy" decoding="async" /></a>
  <figcaption>Photo Print adds a paper border, with the shooting details below the image.</figcaption>
</figure>

When you're happy with it, ask the assistant to create a public repository called `photography` under your GitHub account, upload the website, and enable GitHub Pages. Follow its instructions whenever you need to sign in or approve something.

To enable Pages yourself, open the repository's **Settings → Pages** and choose **GitHub Actions** under **Source**. If you can't find it, ask the assistant to help you get there.

Once publishing is finished, you can send the address to a friend. Open it on your phone as well, to make sure the photos work away from your own computer.

Future updates follow the same pattern: export some photos, tell the assistant which series they belong to and which one should be the cover, preview the result, then publish.

## What the free setup can and can't do

This setup uses a public repository, GitHub's included website address, and the project's standard automated publishing process. Buying your own domain name or adding paid services would introduce extra costs. [GitHub Pages availability](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site), [automated publishing costs](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

**Your photos will be public.** Use this for work you want to share. People can view and save the display images in the repository. Even after you remove a photo, it may remain in older records or in copies other people have downloaded. Keep private photos elsewhere.

**Storage is limited.** A published GitHub Pages site can be no larger than 1 GB. At 10 MB per original photo, around 100 photos would already approach that size. That's why the images need to be resized and compressed for the web. How many will fit depends on the actual file sizes; ask the assistant to check before publishing. Keep your own backups of the originals. GitHub isn't a place to back up your entire photo library. [Pages size limit](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [repository storage guidance](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

**Traffic and loading speed have limits, too.** GitHub Pages has a soft bandwidth limit of 100 GB per month. Loading speed can also vary by region and network. As your collection or audience grows, you can move the images to a dedicated storage service. [Bandwidth limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

**There is some upkeep.** Adding photos currently involves your computer and the assistant; it doesn't automatically sync with your phone's photo library. This is a setup for a personal portfolio. A paid service hosting websites for many users would need a different plan, and GitHub Pages has specific restrictions on commercial SaaS hosting. [Usage policy](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

For me, having somewhere to put the photos I care about is enough to start with. The site can change over time, and the collection can grow a little at a time.

## Copy this prompt to get started

Create your GitHub account first, then send the following to your AI coding assistant. Replace the text in brackets with your details. If you're unsure about something, leave it blank and let the assistant ask.

```text
I don't know how to code. Please help me build and publish my own photography website, guiding me one step at a time.

Start by reading the documentation and code in this reference project:
https://github.com/suxiaogang223/photography

My details:
- GitHub username: [your username]
- Website name: [your choice, or suggest a few]
- Photographer name and introduction: [fill in, or ask me]
- Photo folder: [the path; if I don't know how to find it, show me]
- Series names and preferred covers: [fill in, or suggest after viewing the photos]

Keep the website and its processed display images in my own public GitHub repository. Publish through GitHub Pages using a free github.io address. I don't want to purchase a domain, server, or object storage at this stage.

Work in a new, separate folder. Replace the original author's photos, name, introduction, and links with mine. Keep series browsing, the photo lightbox, and Photo Print. Don't change my original photos or any existing websites. Preserve the full image, including the orientation of portrait photos.

Read available shooting details from the photos. Ask me about cameras, film stocks, and dates for film photos. Don't guess missing information. Adapt checks that depend on the original author's personal content to work with my website.

Check what software I need before starting. When I need to sign in, authorize something, or click on a webpage, explain where to go and what to click. Give me only the steps I need at that point. I'll enter passwords and verification codes myself.

Show me a local preview first and wait for my approval before uploading and publishing. Before publishing, check image sizes, what will be public, and the website address. Afterwards, actually open the homepage, a series, and a photo to verify that they work. Give me the final address and show me how to add photos next time.

If you can't access the repository or work with files on my computer, explain that and tell me how to provide the files or complete the steps. Don't just give me a pile of code, and don't say the site is live unless publishing has actually succeeded.
```
