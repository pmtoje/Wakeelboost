"""
Build WakeelBoost agreement templates from the bank's Murabaha pre-disbursement agreements and
Murabaha (sale) contracts (post-disbursement, MetLaw edits).

  python3 scripts/build-agreement-templates.py \
      PRE_INDIVIDUAL.docx PRE_ENTERPRISE.docx PRE_COMPANY.docx \
      POST_INDIVIDUAL.docx POST_ENTERPRISE.docx OUT_DIR

What it does (python-docx 1.2):
  * Replaces the dotted blanks that the facility record can answer with {{placeholders}}: dates,
    the customer party, the goods, cost price, contract (sale) price, markup, instalment, tenor and
    the customer's AltBank account. Each placeholder is written into a single run.
  * Fills the bank's two signatories (the same officers who sign the offer letter) and, on the
    Company agreement, the first two directors' names. The two columns are aligned with one tab
    stop so names of any length line up.
  * Leaves the security deposit (Hamish Jiddiyah) and the witness lines for completion by hand
    (or on the tablet signature page).
  * Scrubs document author metadata.

The bank's clauses, numbering and layout are otherwise unchanged.
"""
import os
import re
import sys
from docx import Document

DOTS = "[….·_xX  ]"


def runs_replace(p, pattern, new, count=1):
    """Regex-replace within a paragraph's combined text, keeping the first affected run's formatting."""
    runs = p.runs
    text = "".join(r.text for r in runs)
    m = re.search(pattern, text)
    if not m:
        raise SystemExit(f"Pattern not found: {pattern!r} :: {text[:200]!r}")
    i, end = m.span()
    pos = 0
    placed = False
    for r in runs:
        t = r.text
        s, e = pos, pos + len(t)
        pos = e
        if e <= i or s >= end:
            if s >= end and not placed:
                pass
            continue
        a, b = max(i, s) - s, min(end, e) - s
        if not placed:
            r.text = t[:a] + new + t[b:]
            placed = True
        else:
            r.text = t[:a] + t[b:]
    if not placed:
        raise SystemExit(f"Could not place {new!r}")
    if count > 1:
        runs_replace(p, pattern, new, count - 1)


def para(doc, contains, nth=0):
    hits = [p for p in doc.paragraphs if contains in p.text]
    if len(hits) <= nth:
        raise SystemExit(f"Paragraph not found: {contains!r}")
    return hits[nth]


AGREEMENT_DATE = "{{agreement_day}} day of {{agreement_month_year}}"
OFFER_DATE = "{{offer_letter_day}} day of {{offer_letter_month_year}}"


def effective_date(doc, contains):
    runs_replace(para(doc, contains), r"made this\s*[….]+\s*\.*\s*day of\s*[….]+\s*20[0-9….X]*", "made this " + AGREEMENT_DATE + " ")


def offer_dated(doc, contains="dated"):
    p = para(doc, "Further to the")
    runs_replace(p, r"dated\s*[….]+\s*day of\s*[….]+\s*20[0-9….X]*", "dated the " + OFFER_DATE)


def two_columns(p, left, right):
    """Rewrite a 'Name:<tabs>Name:' line as 'left<one tab>right' with a fixed tab stop."""
    from docx.shared import Inches
    runs = p.runs
    runs[0].text = left + "\t" + right
    for r in runs[1:]:
        r.text = ""
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT  # justified text stretches tabbed columns
    p.paragraph_format.tab_stops.clear_all()
    p.paragraph_format.tab_stops.add_tab_stop(Inches(3.6))


def signatories(doc, heading, names, titles=None):
    """Fill the Name/Title lines that follow a 'SIGNED FOR AND ON BEHALF OF …' heading."""
    paras = doc.paragraphs
    start = next(i for i, p in enumerate(paras) if heading in p.text)
    line = next((p for p in paras[start + 1:] if p.text.startswith("____") and "\t" in p.text), None)
    if line is not None:
        two_columns(line, "_" * 20, "_" * 20)
    name = next(p for p in paras[start + 1:] if p.text.startswith("Name:") and "\t" in p.text)
    title = next(p for p in paras[start + 1:] if p.text.startswith("Title:") and "\t" in p.text)
    two_columns(name, f"Name: {names[0]}", f"Name: {names[1]}")
    t = titles or ("", "")
    two_columns(title, f"Title: {t[0]}".rstrip(), f"Title: {t[1]}".rstrip())


BANK_NAMES = ("{{signatory_1_name}}", "{{signatory_2_name}}")
BANK_TITLES = ("{{signatory_1_title}}", "{{signatory_2_title}}")


def bank_signatories(doc):
    signatories(doc, "SIGNED FOR AND ON BEHALF OF ALTERNATIVE BANK", BANK_NAMES, BANK_TITLES)


def scrub(doc):
    cp = doc.core_properties
    cp.author = "The Alternative Bank"
    cp.last_modified_by = "WakeelBoost"
    cp.comments = ""


def pre_common(doc, plural=False):
    offer_dated(doc)
    asset = "Assets" if plural else "Asset"
    runs_replace(para(doc, "Further to the"), r"acquire\s*[….]+", "acquire {{financed_items}}")
    p = para(doc, "Cost Price")
    runs_replace(p, r"sum of N[….]+", "sum of {{cost_price}} ")
    runs_replace(p, r"sum of [….]+", "sum of {{cost_plus_markup}} ")
    runs_replace(p, r"profit of [….]+", "profit of {{markup}}")
    runs_replace(para(doc, "DOMICILE AND ROUTE"), r"Account No[….]+", "Account No. {{customer_account}} ")
    runs_replace(para(doc, "TO DEBIT"), r"Account number[….]+", "Account number {{customer_account}} ")


def build_pre_individual(src, out):
    doc = Document(src)
    effective_date(doc, "PRE-DISBURSEMENT AGREEMENT (this")
    runs_replace(para(doc, "(the “CUSTOMER”)"), r"^[….]+of[….]+", "{{customer_name}} of {{customer_address}}")
    pre_common(doc)
    runs_replace(para(doc, "NAME OF CUSTOMER:"), r"NAME OF CUSTOMER:_+", "NAME OF CUSTOMER: {{customer_name}}")
    bank_signatories(doc)
    scrub(doc)
    doc.save(out)


def build_pre_enterprise(src, out):
    doc = Document(src)
    effective_date(doc, "PRE-DISBURSEMENT AGREEMENT is made")
    p = para(doc, "trading in the Name and Style of")
    runs_replace(p, r"^[….]+", "{{proprietor_name}} ")
    runs_replace(p, r"Style of[….]+\)", "Style of {{business_name}})")
    runs_replace(p, r"address at [….]+", "address at {{customer_address}} ")
    pre_common(doc)
    runs_replace(para(doc, "NAME OF CUSTOMER:"), r"NAME OF CUSTOMER:\s+\(trading in the Name of _+\)", "NAME OF CUSTOMER: {{proprietor_name}} (trading in the Name of {{business_name}})")
    bank_signatories(doc)
    scrub(doc)
    doc.save(out)


def build_pre_company(src, out):
    doc = Document(src)
    effective_date(doc, "PRE-DISBURSEMENT AGREEMENT is made")
    runs_replace(para(doc, "(the “CUSTOMER”)"), r"^[….]+\s*of\s+", "{{company_name}} of {{customer_address}} ")
    pre_common(doc, plural=True)
    runs_replace(para(doc, "SIGNED FOR AND ON BEHALF OF …"), r"OF [….]+ LIMITED", "OF {{company_name}}")
    bank_signatories(doc)
    signatories(doc, "SIGNED FOR AND ON BEHALF OF {{company_name}}", ("{{first_director_name}}", "{{second_director_name}}"))
    scrub(doc)
    doc.save(out)


def post_common(doc):
    offer_dated(doc)
    # Goods table: one repeating row (grows to one row per item); the bank's blank rows 2 and 3 are removed.
    t = doc.tables[0]
    row = t.rows[1]
    for cell, text in ((row.cells[0], "{{#asset_rows}}{{item_no}}."), (row.cells[1], "{{item_description}}"), (row.cells[2], "{{item_units}}{{/asset_rows}}")):
        p = cell.paragraphs[0]
        if p.runs:
            p.runs[0].text = text
            for r in p.runs[1:]:
                r.text = ""
        else:
            p.add_run(text)
    for extra in list(t.rows)[2:]:
        extra._tr.getparent().remove(extra._tr)
    runs_replace(para(doc, "Cost Price-"), r"[….]+", "{{cost_price}}")
    runs_replace(para(doc, "Sale Price-"), r"[….]+", "{{cost_plus_markup}}")
    runs_replace(para(doc, "Monthly Instalment-"), r"N[….]+", "{{instalment_amount}}")
    runs_replace(para(doc, "Mark Up-"), r"[….]+", "{{markup}}")
    runs_replace(para(doc, "Tenor…"), r"Tenor[….]+", "Tenor- {{tenor_months}} months")
    # Appendix A: receipt of asset
    p = para(doc, "hereby confirm receipt")
    runs_replace(p, r"^[….]+,?", "{{customer_name}},")
    runs_replace(p, r"the\s*[….]+\s*\(THE ASSET\)", "the {{financed_items}} (THE ASSET)")
    runs_replace(p, r"dated\s*[….]+\s*day of\s*[….]+\s*20[0-9….X]*", "dated the " + AGREEMENT_DATE)
    runs_replace(para(doc, "Dated this"), r"Dated this[….]+\s*day of\s*[….]+\s*20[0-9….X]*", "Dated this " + AGREEMENT_DATE)


def build_post_individual(src, out):
    doc = Document(src)
    p = para(doc, "MURABAHA (SALES) CONTRACT is made")
    runs_replace(p, r"made this\s*[….]+\s*day of[….]+\s*20[0-9….X]*", "made this " + AGREEMENT_DATE + " ")
    runs_replace(p, r"AND\s*[….]+\s*of\s*[….]+", "AND {{customer_name}} of {{customer_address}} ")
    post_common(doc)
    runs_replace(para(doc, "NAME OF CUSTOMER:", 0), r"NAME OF CUSTOMER:\s+_+", "NAME OF CUSTOMER: {{customer_name}}")
    runs_replace(para(doc, "NAME OF CUSTOMER:", 1), r"NAME OF CUSTOMER:\s*_+", "NAME OF CUSTOMER: {{customer_name}}")
    bank_signatories(doc)
    scrub(doc)
    doc.save(out)


def build_post_enterprise(src, out):
    doc = Document(src)
    runs_replace(para(doc, "MURABAHA (SALES) CONTRACT is made"), r"made this\s*[….]+\s*day of\s*[….]+\s*20[0-9….X]*", "made this " + AGREEMENT_DATE + " ")
    p = para(doc, "trading in the Name of")
    runs_replace(p, r"^[….]+", "{{proprietor_name}} ")
    runs_replace(p, r"Name of[….]+\)", "Name of {{business_name}})")
    runs_replace(p, r"address at t?[….]+", "address at {{customer_address}} ")
    post_common(doc)
    # Signature block (split over two paragraphs in the bank's file)
    runs_replace(para(doc, "NAME OF CUSTOMER:", 0), r"NAME OF CUSTOMER:\s+_+\s+\(trading in the Name", "NAME OF CUSTOMER: {{proprietor_name}} (trading in the Name")
    runs_replace(para(doc, " of ____"), r"of _+\)", "of {{business_name}})")
    runs_replace(para(doc, "NAME OF CUSTOMER:", 1), r"NAME OF CUSTOMER:\s+x+\s+\(trading in the Name of _+\)", "NAME OF CUSTOMER: {{proprietor_name}} (trading in the Name of {{business_name}})")
    bank_signatories(doc)
    scrub(doc)
    doc.save(out)


def check(path):
    """Every placeholder must sit inside one run; report the ones produced."""
    import zipfile
    xml = zipfile.ZipFile(path).read("word/document.xml").decode()
    found = sorted(set(re.findall(r"\{\{([^{}]+)\}\}", xml)))
    text = re.sub(r"<[^>]+>", "", xml)
    if len(re.findall(r"\{\{", text)) != len(re.findall(r"\{\{[^{}]+\}\}", xml)):
        raise SystemExit(f"{path}: a placeholder is split across runs")
    return found


if __name__ == "__main__":
    if len(sys.argv) != 7:
        raise SystemExit(__doc__)
    pi, pe, pc, qi, qe, out = sys.argv[1:]
    os.makedirs(out, exist_ok=True)
    jobs = [
        (build_pre_individual, pi, "pre-disbursement-individual.docx"),
        (build_pre_enterprise, pe, "pre-disbursement-enterprise.docx"),
        (build_pre_company, pc, "pre-disbursement-limited.docx"),
        (build_post_individual, qi, "sale-contract-individual.docx"),
        (build_post_enterprise, qe, "sale-contract-enterprise.docx"),
    ]
    for fn, src, name in jobs:
        dest = os.path.join(out, name)
        fn(src, dest)
        print("built", dest, check(dest))
