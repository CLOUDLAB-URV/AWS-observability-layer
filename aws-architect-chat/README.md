This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Deploy To AWS

The deploy flow uses a local MCP proxy so the browser never talks to AWS directly.

1. Start the Next.js app with `pnpm dev`.
2. Start the local proxy with `pnpm proxy` in a second terminal. This runs the standalone server from [local-proxy/proxy.js](local-proxy/proxy.js), separate from the web app.
3. Ensure your local AWS credentials are available to the host machine.
4. Open the app, select a project, and click `Deploy to AWS`.

The UI will validate the proxy with a health check, open an SSE stream for live deployment logs, and append each streamed event into `persistence/<project>/workflow.json`.

### Manual Verification Flow

1. Ask the model to provision a minimal architecture using `t2.nano` or the closest equivalent available in the region.
2. Confirm the AWS resources appear in your account and that the terminal panel shows the proxy SSE stream.
3. Inspect `persistence/<project>/workflow.json` to verify the streamed deployment entries were appended incrementally.
4. Trigger the teardown step from the same deployment flow and confirm the created resources are removed.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
