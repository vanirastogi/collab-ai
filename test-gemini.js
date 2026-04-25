import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI("AIzaSyDXm8SDROKfGlJwyfg7oPgywi8VcytHg8w");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
async function test() {
  try {
    const result = await model.generateContentStream("Say hi");
    for await (const chunk of result.stream) {
      console.log("Chunk:", chunk.text());
    }
  } catch (e) { console.error(e); }
}
test();
