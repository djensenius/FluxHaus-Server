import fs from 'fs';

export async function writeError(device: string, message: string): Promise<void> {
  if (!fs.existsSync('cache/errors.json')) {
    fs.writeFileSync(
      'cache/error.json',
      JSON.stringify({ timestamp: new Date(), device: message }, null, 2),
    );
  } else {
    const errors = JSON.parse(fs.readFileSync('cache/errors.json', 'utf8'));
    errors[device] = message;
    fs.writeFileSync('cache/errors.json', JSON.stringify(errors, null, 2));
  }
}

export async function clearError(device: string): Promise<void> {
  if (fs.existsSync('cache/errors.json')) {
    const errors = JSON.parse(fs.readFileSync('cache/errors.json', 'utf8'));
    delete errors[device];
    fs.writeFileSync('cache/errors.json', JSON.stringify(errors, null, 2));
  }
}
