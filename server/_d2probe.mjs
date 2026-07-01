import { D2 } from '@terrastruct/d2';
const d2 = new D2();
const src = `direction: right
aws: "AWS Cloud" {
  lambda: "Lambda\\nNode 20" {
    icon: "https://api.iconify.design/logos:aws-lambda.svg"
    shape: rectangle
    tooltip: "This is a Lambda function"
    link: "https://example.com/lambda"
  }
  rds: "RDS" { shape: cylinder }
}
client: "Internet" { shape: person }
client -> aws.lambda: "HTTPS :443"
aws.lambda -> aws.rds: "TCP :5432"
`;
const compiled = await d2.compile(src, { layout: 'elk' });
const svg = await d2.render(compiled.diagram, { ...compiled.renderOptions, themeID: 4 });
console.log('SVG length:', svg.length);
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], svg);
