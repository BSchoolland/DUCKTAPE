/**
 * Splits a message into chunks that don't exceed Discord's 2000 character limit
 * @param {string} text - The text to split
 * @returns {Array<string>} Array of message chunks
 */
export function splitMessage(text) {
  const maxLength = 2000;
  const chunks = [];
  
  let currentChunk = "";
  const lines = text.split("\n");
  
  for (const line of lines) {
    if ((currentChunk + line + "\n").length <= maxLength) {
      currentChunk += line + "\n";
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = line + "\n";
      
      // If a single line exceeds max length, break it character by character
      if (currentChunk.length > maxLength) {
        while (currentChunk.length > maxLength) {
          chunks.push(currentChunk.substring(0, maxLength));
          currentChunk = currentChunk.substring(maxLength);
        }
      }
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

