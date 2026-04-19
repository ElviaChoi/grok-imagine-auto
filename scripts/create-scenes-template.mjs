import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = new URL("../templates/", import.meta.url);
await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();
const scenes = workbook.worksheets.add("Scenes");
const guide = workbook.worksheets.add("Guide");

scenes.showGridLines = false;
guide.showGridLines = false;

scenes.getRange("A1:B1").values = [["image", "prompt"]];
scenes.getRange("A2:B21").values = Array.from({ length: 20 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return [
    `scene-${number}.png`,
    index < 3
      ? [
          "A calm cinematic shot of a quiet winter village",
          "A woman walking through a snowy market at dawn",
          "Steam rising from a large pot in a traditional kitchen"
        ][index]
      : ""
  ];
});

const header = scenes.getRange("A1:B1");
header.format = {
  fill: "#173B2F",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center"
};
header.format.rowHeightPx = 28;

scenes.getRange("A:A").format.columnWidthPx = 150;
scenes.getRange("B:B").format.columnWidthPx = 520;
scenes.getRange("A2:B21").format.wrapText = true;
scenes.getRange("A2:B21").format.verticalAlignment = "top";
scenes.freezePanes.freezeRows(1);

const table = scenes.tables.add("A1:B21", true, "ScenesTable");
table.style = "TableStyleMedium4";
table.showFilterButton = true;

guide.getRange("A1:D1").merge();
guide.getRange("A1").values = [["Grok Imagine Auto - Excel Template"]];
guide.getRange("A1").format = {
  fill: "#111111",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "center"
};
guide.getRange("A3:B10").values = [
  ["Step", "How to use"],
  ["1", "Fill the Scenes sheet. Use one row per scene."],
  ["2", "Put the exact image file name in the image column, such as scene-01.png."],
  ["3", "Put the Grok prompt in the prompt column."],
  ["4", "Save this workbook as CSV UTF-8, or copy the table into a CSV file."],
  ["5", "In the extension side panel, choose the CSV/TSV file and select all image files."],
  ["6", "Click '표 내용으로 채우기' to populate scenes automatically."],
  ["Note", "The browser cannot read local file paths from Excel. Use image file names, then select the images separately."]
];
guide.getRange("A3:B3").format = {
  fill: "#173B2F",
  font: { bold: true, color: "#FFFFFF" }
};
guide.getRange("A:B").format.wrapText = true;
guide.getRange("A:A").format.columnWidthPx = 90;
guide.getRange("B:B").format.columnWidthPx = 620;

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(fileURLToPath(new URL("grok-imagine-scenes-template.xlsx", outputDir)));
