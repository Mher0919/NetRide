process.on('unhandledRejection', (reason) => {
  console.error('[HOOK] UNHANDLED REJECTION:', reason instanceof Error ? reason.message : String(reason));
  if (reason instanceof Error && reason.stack) {
    console.error('[HOOK] STACK:', reason.stack.split('\n').slice(1, 8).join('\n'));
  }
});