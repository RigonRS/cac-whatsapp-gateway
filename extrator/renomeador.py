# -*- coding: utf-8 -*-
"""
Renomeador automático de documentos (CAC, CRAF, CTF/IBAMA, SIMAF, GTE)
=======================================================================

O que este script faz
----------------------
Lê o CONTEÚDO de cada PDF dentro de uma pasta e renomeia o arquivo de
acordo com o tipo de documento identificado:

1) Contém "Certificado de Registro" e "Atividades Autorizadas"
   -> "Certificado de Registro CAC.pdf"

2) Contém "Certificado de Registro de Arma de Fogo" (ou "... Federal de Arma")
   -> "CRAF <Tipo> <Marca>.pdf"
      Lê TIPO/MARCA pela posição na página (modelos com rótulo em cima do
      valor, inclusive o novo da PF de 2026) ou pelo texto "Espécie: X" /
      "Marca: Y" (modelo da PF/SEI e SINARM antigo).

3) Contém "Guia" (Guia de Tráfego Especial)
   -> "GT <Tipo> <Marca> <Finalidade> <Destino> Val DD-MM-AAAA.pdf"
      Finalidade normalizada para: Caça / Caça-Treinamento / Tiro Desportivo
      Destino conforme a finalidade:
      - Caça: "Cidade-UF" (campo País/Cidade/UF/Aeroporto-Porto)
      - Caça-Treinamento: nome do local (início do campo Endereço e CEP)
      - Tiro Desportivo: nome do local (campo Nome/Razão Social, sem código)
      Se a guia não traz o nome do local (vem "XXX" ou só o nome da rua),
      usa "Cidade-UF" do campo País/Cidade/UF/Aeroporto-Porto do destino.

4) Contém "Autorização de Controle de Espécies Exóticas Invasoras"
   -> "SIMAF <Nome da propriedade> <Cidade> Val DD-MM-AAAA.pdf"

5) Contém "CERTIFICADO DE REGULARIDADE" (CTF/IBAMA)
   -> "CTF IBAMA Val DD-MM-AAAA.pdf"

6) Laudo de Avaliação Psicológica (manuseio de arma de fogo)
   -> "Avaliação Psicológica Val DD-MM-AAAA.pdf"  (validade = data da avaliação + 1 ano)

7) Comprovante de Capacidade Técnica (Teste de Tiro)
   -> "Teste de Tiro <Tipo> Val DD-MM-AAAA.pdf"   (validade = data do teste + 1 ano)

Guias de Tráfego também com as finalidades "Mudança de Local de Acervo"
(inclusive a guia manual da PF de retirada de arma) e "Manutenção" (ida ao
armeiro): destino = "Cidade-UF".

PDF sem texto (impresso como imagem, escaneado ou "Imprimir para PDF"): o
texto é lido por OCR com o Tesseract, se ele estiver instalado no computador
(https://github.com/UB-Mannheim/tesseract). O idioma português fica na
subpasta "tessdata" ao lado deste script.

Arquivos cujo conteúdo não se encaixa em nenhuma regra, ou cujos campos
não puderam ser lidos com segurança, NÃO são renomeados — eles aparecem
na lista "NÃO CLASSIFICADOS / REVISAR MANUALMENTE" ao final da execução.

Como usar
---------
Este script e os dois atalhos (.bat) ficam sempre juntos, aqui nesta
pasta. Mas eles funcionam em QUALQUER pasta de PDFs do seu computador —
não precisa copiar nada para lá.

1. Instale a biblioteca necessária (uma única vez):
       pip install pdfplumber

2. Dê 2 cliques em "1 - TESTAR (simulação).bat".
   - Vai abrir uma janela para você escolher a pasta com os PDFs.
   - Ele só mostra o que faria — nenhum arquivo é alterado.
   - (Também dá pra arrastar uma pasta em cima do atalho, em vez de
     escolher pela janela.)

3. Depois de conferir a lista, dê 2 cliques em
   "2 - RENOMEAR DE VERDADE.bat" e escolha a mesma pasta — aí sim os
   arquivos são renomeados de fato.

Uso pelo terminal (opcional):
       py renomear_documentos.py --pasta "C:\\caminho\\da\\pasta" --aplicar
"""

import argparse
import datetime
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    print("ERRO: a biblioteca 'pdfplumber' não está instalada.")
    print("Instale com:  pip install pdfplumber")
    sys.exit(1)

# Tenta garantir que acentos apareçam corretamente no console do Windows.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ILLEGAL_CHARS = '<>:"/\\|?*'
DATE_RE = r"(\d{2}/\d{2}/\d{4})"


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def strip_accents(text):
    return "".join(
        c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)
    )


def norm(text):
    """Minúsculo e sem acentos, só para comparação/busca de palavras-chave."""
    return strip_accents(text).lower()


def sanitize_filename(name):
    for ch in ILLEGAL_CHARS:
        name = name.replace(ch, "-")
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name


def date_to_dash(date_str):
    return date_str.replace("/", "-")


def join_parts(*parts):
    parts = [p.strip() for p in parts if p and p.strip()]
    return sanitize_filename(" ".join(parts))


def extract_full_text(pdf):
    return "\n".join((page.extract_text() or "") for page in pdf.pages)


# ---------------------------------------------------------------------------
# OCR (para PDFs sem texto: escaneados ou "Imprimir para PDF")
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
MIN_TEXTO = 200  # menos que isso = o PDF praticamente não tem texto


def tesseract_cmd():
    for c in (os.environ.get("TESSERACT_CMD"), shutil.which("tesseract"),
              r"C:\Program Files\Tesseract-OCR\tesseract.exe",
              r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
        if c and Path(c).exists():
            return c
    return None


def ocr_pdf(pdf, max_paginas=3):
    """Texto das primeiras páginas lido por OCR ("" se o Tesseract não estiver instalado)."""
    cmd = tesseract_cmd()
    if not cmd:
        return ""
    tessdata = SCRIPT_DIR / "tessdata"
    extra = ["--tessdata-dir", str(tessdata)] if (tessdata / "por.traineddata").exists() else []
    criar = {"creationflags": 0x08000000} if os.name == "nt" else {}  # sem janela preta no Windows
    textos = []
    with tempfile.TemporaryDirectory() as d:
        for i, page in enumerate(pdf.pages[:max_paginas]):
            img = os.path.join(d, f"p{i}.png")
            page.to_image(resolution=300).original.save(img)
            r = subprocess.run([cmd, img, "stdout", "-l", "por", *extra],
                               capture_output=True, timeout=180, **criar)
            textos.append(r.stdout.decode("utf-8", "replace"))
    return "\n".join(textos)


_OCR_FEITO = {}  # arquivo -> texto lido por OCR (evita ler duas vezes o mesmo PDF)


def texto_do_pdf(pdf):
    """(texto, veio_do_ocr). Usa o OCR só quando o PDF não tem texto."""
    texto = extract_full_text(pdf)
    if len(texto.strip()) >= MIN_TEXTO:
        return texto, False
    chave = getattr(getattr(pdf, "stream", None), "name", None)
    lido = _OCR_FEITO.get(chave) if chave else None
    if lido is None:
        lido = ocr_pdf(pdf)
        if chave:
            _OCR_FEITO[chave] = lido
    if len(lido.strip()) > len(texto.strip()):
        return lido, True
    return texto, False


# ---------------------------------------------------------------------------
# Datas por extenso (laudos e testes de tiro)
# ---------------------------------------------------------------------------

MESES = {"janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6,
         "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12}


def _data_ok(d, m, a):
    try:
        a = int(a)
        if a < 100:
            a += 2000
        dt = datetime.date(a, int(m), int(d))
    except (ValueError, TypeError):
        return None
    hoje = datetime.date.today()
    if dt.year < 2015 or dt > hoje + datetime.timedelta(days=60):
        return None
    return dt


def datas_no_texto(texto_norm):
    """Datas escritas por extenso ("05 de março de 2026", "27, Março, 2026") ou
    "06 de 04 de 2026". Não pega dd/mm/aaaa (no rodapé costuma ter a data de
    impressão e a validade da portaria do examinador)."""
    out = []
    for d, mes, a in re.findall(r"\b(\d{1,2})\s*,?\s*(?:de\s+)?([a-z]{4,9})\s*,?\s*(?:de\s+)?(\d{4})\b", texto_norm):
        if mes in MESES:
            dt = _data_ok(d, MESES[mes], a)
            if dt:
                out.append(dt)
    for d, m, a in re.findall(r"\b(\d{1,2})\s*_*\s*(?:de\s+)?(\d{1,2})\s+de\s+(\d{4})\b", texto_norm):
        dt = _data_ok(d, m, a)
        if dt:
            out.append(dt)
    return out


def mais_um_ano(dt):
    try:
        return dt.replace(year=dt.year + 1)
    except ValueError:  # 29/02
        return dt.replace(year=dt.year + 1, day=28)


def fmt_dash(dt):
    return dt.strftime("%d-%m-%Y")


def extract_all_tables(pdf):
    tables = []
    for page in pdf.pages:
        for tbl in page.extract_tables() or []:
            tables.append(tbl)
    return tables


def table_lookup(tables, header_keywords):
    """
    Procura, em todas as tabelas extraídas, uma linha de cabeçalho cujas
    células (normalizadas) contenham as palavras-chave pedidas, e devolve
    o valor da(s) coluna(s) correspondentes na primeira linha de dados
    logo abaixo que tiver conteúdo.

    header_keywords: dict {nome_logico: substring_normalizada_no_header}
    Retorna dict {nome_logico: {"header": texto_do_cabecalho, "value": valor_da_celula}}
    ou {} se não encontrar. Use cell_value(res, nome) para pegar só o valor.
    """
    for table in tables:
        for r, row in enumerate(table):
            if row is None:
                continue
            norm_row = [norm(c) if c else "" for c in row]
            col_map = {}
            for logical_name, keyword in header_keywords.items():
                for c_idx, cell_norm in enumerate(norm_row):
                    if keyword in cell_norm:
                        col_map[logical_name] = c_idx
                        break
            if len(col_map) == len(header_keywords):
                # achou uma linha de cabeçalho com todas as colunas pedidas;
                # procura a próxima linha com dados reais
                for data_row in table[r + 1:]:
                    if not data_row:
                        continue
                    if any((data_row[i] or "").strip() for i in col_map.values() if i < len(data_row)):
                        result = {}
                        for logical_name, c_idx in col_map.items():
                            val = data_row[c_idx] if c_idx < len(data_row) else ""
                            header_text = row[c_idx] if c_idx < len(row) else ""
                            result[logical_name] = {
                                "header": (header_text or "").strip(),
                                "value": (val or "").strip(),
                            }
                        return result
    return {}


def cell_value(res, logical_name):
    """Valor simples de uma coluna encontrada por table_lookup (sem tratar
    células compostas)."""
    entry = res.get(logical_name)
    if not entry:
        return ""
    return entry.get("value", "")


def compound_cell_value(res, logical_name, keyword):
    """
    Algumas Guias (modelo Exército) juntam dois campos numa célula só,
    com o cabeçalho também composto, ex.: cabeçalho "Mercadoria/Espécie"
    e valor "- / PISTOLA", ou cabeçalho "Modelo/Lote" e valor "G19 / -".
    Esta função identifica, pela posição da palavra-chave dentro do
    cabeçalho composto, qual pedaço do valor pegar.

    Se o cabeçalho for simples (sem "/"), devolve o valor inteiro sem
    mexer — cobre o caso comum de "Espécie"/"Modelo" já virem sozinhos,
    inclusive quando o próprio valor contém uma "/" (ex.: "carabina / FUZIL").
    """
    entry = res.get(logical_name)
    if not entry:
        return ""
    header_text = entry.get("header", "")
    value_text = entry.get("value", "")
    if "/" not in header_text:
        return value_text

    header_parts = [norm(h.strip()) for h in header_text.split("/")]
    idx = next((i for i, h in enumerate(header_parts) if keyword in h), None)
    if idx is None:
        return value_text

    value_parts = [v.strip() for v in value_text.split("/", 1)]
    if idx >= len(value_parts):
        return value_text
    picked = value_parts[idx]
    return "" if picked == "-" else picked


# ---------------------------------------------------------------------------
# Extração específica para CRAF: valores de TIPO e MARCA a partir da posição
# das palavras na página (mais confiável do que tentar adivinhar pela ordem
# do texto, já que TIPO/MARCA ficam lado a lado em caixas separadas).
# ---------------------------------------------------------------------------

def extract_tipo_marca_by_position(pdf):
    for page in pdf.pages:
        words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
        tipo_label = next((w for w in words if w["text"].strip().upper() == "TIPO"), None)
        marca_label = next((w for w in words if w["text"].strip().upper() == "MARCA"), None)
        if not tipo_label or not marca_label:
            continue
        if abs(tipo_label["top"] - marca_label["top"]) > 6:
            continue  # não estão na mesma linha, provavelmente não é o par certo

        boundary_x = marca_label["x0"]
        label_bottom = max(tipo_label["bottom"], marca_label["bottom"])

        # limite inferior da janela de busca: próximo label conhecido (CALIBRE),
        # senão um valor fixo generoso.
        calibre_label = next((w for w in words if w["text"].strip().upper() == "CALIBRE"), None)
        lower_bound = calibre_label["top"] if calibre_label and calibre_label["top"] > label_bottom else label_bottom + 40

        value_words = [
            w for w in words
            if label_bottom - 1 < w["top"] < lower_bound
            and w["text"].strip().upper() not in ("TIPO", "MARCA")
        ]
        if not value_words:
            continue

        value_words.sort(key=lambda w: (round(w["top"]), w["x0"]))
        tipo_words = [w["text"] for w in value_words if w["x0"] < boundary_x]
        marca_words = [w["text"] for w in value_words if w["x0"] >= boundary_x]
        tipo_val = " ".join(tipo_words).strip()
        marca_val = " ".join(marca_words).strip()
        if tipo_val or marca_val:
            return tipo_val, marca_val
    # Modelo novo da PF ("Visualizar Documento (CRAF)", 2026): TIPO e MARCA
    # ficam em linhas diferentes ("N. DO REGISTRO  TIPO" e "CALIBRE  MARCA"),
    # cada rótulo com o valor logo na linha de baixo.
    for page in pdf.pages:
        words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
        tipo_val = valor_abaixo_do_rotulo(words, "TIPO")
        marca_val = valor_abaixo_do_rotulo(words, "MARCA")
        if tipo_val and marca_val:
            return tipo_val, marca_val
    return "", ""


def valor_abaixo_do_rotulo(words, rotulo):
    """Texto da linha logo abaixo do rótulo, na coluna do rótulo (o valor
    começa até 6pt à esquerda dele e vai até a próxima coluna)."""
    label = next((w for w in words if w["text"].strip().upper() == rotulo), None)
    if not label:
        return ""
    abaixo = [w for w in words if label["bottom"] - 1 < w["top"] < label["bottom"] + 16]
    if not abaixo:
        return ""
    linha_top = min(w["top"] for w in abaixo)
    linha = [w for w in abaixo if abs(w["top"] - linha_top) < 3]
    # Próximo rótulo à direita na mesma linha do rótulo limita a coluna.
    vizinhos = [w["x0"] for w in words if abs(w["top"] - label["top"]) < 3 and w["x0"] > label["x1"] + 20]
    limite = min(vizinhos) - 6 if vizinhos else float("inf")
    valor = [w for w in sorted(linha, key=lambda w: w["x0"]) if label["x0"] - 6 <= w["x0"] < limite]
    return " ".join(w["text"] for w in valor).strip()


# ---------------------------------------------------------------------------
# Classificadores / geradores de nome — um por tipo de documento
# ---------------------------------------------------------------------------

def extract_tipo_marca_por_rotulo(full_text):
    """CRAF da PF no formato "Rótulo: valor" (SEI e SINARM antigo), ex.:
    "Espécie: PISTOLA" e "Marca: FORJAS TAURUS Modelo: PT138"."""
    fim = r"(?=\s{2,}|\s+(?:Modelo|N[ºo°] da Arma|SINARM|MINIST|DEPART|Capacidade|Esp[ée]cie)\b|\n|$)"
    m_tipo = re.search(r"Esp[ée]cie\s*:\s*(carabina\s*/\s*fuzil|[^\s\d:]+)", full_text, re.IGNORECASE)
    m_marca = re.search(r"Marca\s*:\s*(.+?)" + fim, full_text, re.IGNORECASE)
    tipo = m_tipo.group(1).strip() if m_tipo else ""
    marca = m_marca.group(1).strip() if m_marca else ""
    return tipo, marca


def rule_craf(full_text_norm, full_text, pdf):
    if ("certificado de registro de arma de fogo" not in full_text_norm
            and "certificado de registro federal de arma" not in full_text_norm):
        return None
    tipo, marca = extract_tipo_marca_by_position(pdf)
    if not tipo and not marca:
        tipo, marca = extract_tipo_marca_por_rotulo(full_text)
    if not tipo and not marca:
        return None, "CRAF: não consegui ler TIPO/MARCA (verifique manualmente)."
    name = join_parts("CRAF", tipo, marca)
    return name, None


def rule_cac(full_text_norm, full_text, pdf):
    if "certificado de registro" not in full_text_norm:
        return None
    if "atividades autorizadas" not in full_text_norm:
        return None
    name = join_parts("Certificado de Registro CAC")
    return name, None


def rule_ctf(full_text_norm, full_text, pdf):
    # Exige também "cadastros tecnicos federais" para não confundir com
    # outros documentos que apenas MENCIONAM "Certificado de Regularidade"
    # de passagem (ex.: a Autorização do SIMAF cita esse termo num item).
    if "certificado de regularidade" not in full_text_norm:
        return None
    if "cadastros tecnicos federais" not in full_text_norm:
        return None
    tables = extract_all_tables(pdf)
    valido_ate = None
    res = table_lookup(tables, {"valido_ate": "cr valido ate"})
    if cell_value(res, "valido_ate"):
        m = re.search(DATE_RE, cell_value(res, "valido_ate"))
        if m:
            valido_ate = m.group(1)
    if not valido_ate:
        # fallback: registro (numero) + 3 datas na mesma linha; a 3a e a "valido ate"
        m = re.search(r"\d{5,}\s+" + DATE_RE + r"\s+" + DATE_RE + r"\s+" + DATE_RE, full_text)
        if m:
            valido_ate = m.group(3)
    if not valido_ate:
        return None, "CTF/IBAMA: não encontrei a data 'CR válido até'."
    name = join_parts("CTF IBAMA Val", date_to_dash(valido_ate))
    return name, None


def rule_simaf(full_text_norm, full_text, pdf):
    if "autorizacao de controle de especies exoticas invasoras" not in full_text_norm:
        return None
    tables = extract_all_tables(pdf)
    res = table_lookup(tables, {"propriedade": "propriedade", "cidade": "cidade"})
    propriedade = cell_value(res, "propriedade")
    cidade = cell_value(res, "cidade")
    m = re.search(r"Fim\s*:?\s*" + DATE_RE, full_text, re.IGNORECASE)
    if not m:
        return None, "SIMAF: não encontrei a 'Data Fim'."
    data_fim = m.group(1)
    if not propriedade and not cidade:
        return None, "SIMAF: não consegui ler Nome da propriedade / Cidade (verifique manualmente)."
    name = join_parts("SIMAF", propriedade, cidade, "Val", date_to_dash(data_fim))
    return name, None


def normalize_finalidade(raw):
    n = norm(raw)
    # Mudança de local de acervo (inclui a guia manual da PF de retirada da
    # arma na casa do proprietário anterior) e manutenção (ida ao armeiro).
    if "mudanca de local" in n or "retirada de arma" in n:
        return "Mudança de Local de Acervo"
    if "manutencao" in n:
        return "Manutenção"
    # "esportivo" cobre tanto "Tiro Esportivo" quanto "Tiro Desportivo"
    # (os dois termos aparecem em guias reais, dependendo do órgão emissor).
    if "esportivo" in n:
        return "Tiro Desportivo"
    if "caca" in n and "treinamento" in n:
        return "Caça-Treinamento"
    if "caca" in n:
        return "Caça"
    return raw.strip()


def extract_local_destino_block(full_text):
    """Texto entre os títulos '3. LOCAL DE DESTINO' e '4. FINALIDADE'."""
    m = re.search(
        r"3\.\s*LOCAL DE DESTINO(.*?)4\.\s*FINALIDADE",
        full_text,
        re.IGNORECASE | re.DOTALL,
    )
    if m:
        return m.group(1)
    # Guia manual da PF: "LOCAIS DE DESTINO: ... FINALIDADE DO TRÂNSITO"
    m = re.search(r"LOCA(?:L|IS) DE DESTINO:?(.*?)FINALIDADE", full_text, re.IGNORECASE | re.DOTALL)
    return m.group(1) if m else ""


STREET_KEYWORDS_RE = re.compile(
    r"\b(RUA|AVENIDA|AV\.?|TRAVESSA|TRAV\.?|ESTRADA|EST\.?|RODOVIA|ROD\.?|"
    r"ALAMEDA|AL\.?|PRA[CÇ]A)\b",
    re.IGNORECASE,
)


def strip_leading_code(value):
    """Remove um código numérico na frente do nome, ex.: '106620 - CLUBE...'
    -> 'CLUBE...'."""
    return re.sub(r"^\s*\d+\s*-\s*", "", value).strip()


def extract_nome_from_endereco(raw):
    """
    De um campo "Endereço e CEP:" que começa com o nome do local seguido
    do endereço (ex.: "CLUBE INDEPENDENCIA CAÇA E TIRO RUA JOSE MORAES
    BORGES 1300 BAIRRO MAUA, XXX, Vacaria, XXX"), devolve só o nome do
    local, cortando a partir da primeira palavra de logradouro (RUA, AV,
    etc.).
    """
    m = STREET_KEYWORDS_RE.search(raw)
    if m:
        nome = raw[:m.start()].strip().strip(",").strip()
        if nome:
            return nome
    # Não achou palavra de logradouro: usa o primeiro pedaço antes da
    # primeira vírgula como aproximação.
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return parts[0] if parts else raw.strip()


def extract_destino(full_text, finalidade):
    """
    Local de destino da Guia de Tráfego, conforme a finalidade:
    - Caça: "Cidade-UF" tirado de "País / Cidade / UF / Aeroporto-Porto:"
    - Caça-Treinamento: nome do local, tirado do início de "Endereço e CEP:"
    - Tiro Desportivo: valor de "Nome / Razão Social:", sem o código na frente
    Só procura dentro do bloco "3. LOCAL DE DESTINO" (não confundir com o
    "2. LOCAL DE ORIGEM", que tem campos parecidos).
    """
    block = extract_local_destino_block(full_text)
    if not block:
        return ""

    fin_norm = norm(finalidade)

    if "treinamento" in fin_norm:
        m = re.search(r"Endere[cç]o e CEP:?\s*([^\n]+)", block, re.IGNORECASE)
        if m:
            return extract_nome_from_endereco(m.group(1).strip())
        return ""

    if "esportivo" in fin_norm:
        m = re.search(r"Nome\s*/\s*Raz[aã]o Social:?\s*([^\n]+)", block, re.IGNORECASE)
        if m:
            return strip_leading_code(m.group(1).strip())
        return ""

    if "caca" in fin_norm:
        m = re.search(
            r"P[aá][ií]s\s*/\s*Cidade\s*/\s*UF\s*/\s*Aeroporto-?Porto:?\s*([^\n]+)",
            block,
            re.IGNORECASE,
        )
        if not m:
            return ""
        parts = [p.strip() for p in m.group(1).split("/")]
        if len(parts) >= 3 and parts[1] and parts[2]:
            return f"{parts[1]}-{parts[2]}"
        return ""

    return ""


def destino_sem_nome(destino):
    """Destino vazio, só 'XXX' (campo em branco na guia) ou que começa por um
    logradouro (RUA, AV...) em vez do nome do local."""
    d = (destino or "").strip()
    if not d or set(d.upper()) <= set("X- "):
        return True
    return STREET_KEYWORDS_RE.match(d) is not None


def extract_destino_cidade_uf(full_text):
    """'Cidade-UF' do campo 'País / Cidade / UF / Aeroporto-Porto' do bloco
    '3. LOCAL DE DESTINO' (ignora partes 'XXX'). Só a cidade se não houver UF."""
    block = extract_local_destino_block(full_text)
    m = re.search(
        r"P[aá][ií]s\s*/\s*Cidade\s*/\s*UF\s*/\s*Aeroporto-?Porto:?\s*([^\n]+)",
        block,
        re.IGNORECASE,
    )
    if not m:
        # Guia manual da PF: "Município: Vacaria UF: RS"
        m2 = re.search(r"Munic[ií]pio:\s*(.+?)\s+UF:\s*([A-Z]{2})\b", block, re.IGNORECASE)
        return f"{m2.group(1).strip()}-{m2.group(2).upper()}" if m2 else ""
    parts = [p.strip() for p in m.group(1).split("/")]
    preenchido = lambda v: v and not set(v.upper()) <= {"X"}  # noqa: E731
    cidade = parts[1] if len(parts) > 1 and preenchido(parts[1]) else ""
    uf = parts[2] if len(parts) > 2 and preenchido(parts[2]) else ""
    if not cidade:
        return ""
    return f"{cidade}-{uf}" if uf else cidade


def rule_gt(full_text_norm, full_text, pdf):
    if "guia" not in full_text_norm:
        return None
    tables = extract_all_tables(pdf)
    res = table_lookup(tables, {"tipo": "especie", "modelo": "modelo"})
    if not res:  # guia manual da PF: tabela sem a coluna Modelo
        res = table_lookup(tables, {"tipo": "especie"})
    tipo = compound_cell_value(res, "tipo", "especie")
    modelo = compound_cell_value(res, "modelo", "modelo")

    m_fin = (re.search(r"FINALIDADE\s*\n\s*([^\n]+)", full_text, re.IGNORECASE)
             or re.search(r"FINALIDADE[^\n]*\n\s*([^\n]+)", full_text, re.IGNORECASE))
    finalidade = normalize_finalidade(m_fin.group(1)) if m_fin else ""

    destino = extract_destino(full_text, finalidade)
    if destino_sem_nome(destino):
        destino = extract_destino_cidade_uf(full_text) or destino

    m_val = re.search(
        r"Validade\s*:?\s*" + DATE_RE + r"\s*(?:à|a|-|ate|até)\s*" + DATE_RE,
        full_text,
        re.IGNORECASE,
    )
    if not m_val:  # guia manual da PF: "PRAZO DE VALIDADE ... de 11/08/2026 a 10/09/2026"
        m_val = re.search(r"PRAZO DE VALIDADE.*?de\s+" + DATE_RE + r"\s+a\s+" + DATE_RE,
                          full_text, re.IGNORECASE | re.DOTALL)
    if not m_val:
        return None, "GT: não encontrei as duas datas de Validade."
    segunda_data = m_val.group(2)

    if not tipo and not modelo:
        return None, "GT: não consegui ler Tipo/Modelo na tabela de produtos (verifique manualmente)."

    name = join_parts("GT", tipo, modelo, finalidade, destino, "Val", date_to_dash(segunda_data))
    return name, None


def data_avaliacao_psicologica(tn):
    """Data da avaliação do laudo psicológico (texto normalizado)."""
    m = re.search(r"data (?:da |de )?avaliacao\s*:?\s*(\d{1,2})\s*/\s*(\d{1,2})\s*/\s*(\d{2,4})", tn)
    if m:
        dt = _data_ok(*m.groups())
        if dt:
            return dt
    m = re.search(r"data (?:da |de )?avaliacao\s*:?\s*([^\n]{0,40})", tn)
    if m:
        ds = datas_no_texto(m.group(1))
        if ds:
            return ds[0]
    ds = datas_no_texto(tn)  # sem o campo: a data do local/assinatura
    return max(ds) if ds else None


def rule_ap(full_text_norm, full_text, pdf):
    tn = full_text_norm
    if "laudo psicologico" not in tn and not ("avaliacao psicologica" in tn and "manuseio de arma" in tn):
        return None
    dt = data_avaliacao_psicologica(tn)
    if not dt:
        return None, "Avaliação Psicológica: não encontrei a data da avaliação."
    return join_parts("Avaliação Psicológica Val", fmt_dash(mais_um_ano(dt))), None


TIPOS_TESTE = {"pistola": "Pistola", "revolver": "Revólver", "espingarda": "Espingarda",
               "carabina": "Carabina", "rifle": "Rifle", "fuzil": "Fuzil"}


def tipo_arma_teste(tn):
    for padrao in (r"(?:^|\n)[^a-z\n]{0,4}t?ipo\s*:?\s*([a-z]+)",   # "TIPO PISTOLA", "TIPO: Pistola"
                   r"(?:^|\n)[^a-z\n]{0,4}po\s*:\s*([a-z]+)",        # OCR que perdeu o "TI"
                   r"especie\s*:\s*([a-z]+)"):
        for v in re.findall(padrao, tn):
            if v in TIPOS_TESTE:
                return TIPOS_TESTE[v]
    return ""


def rule_teste_tiro(full_text_norm, full_text, pdf):
    tn = full_text_norm
    if "capacidade tecnica" not in tn or "comprovante" not in tn:
        return None
    ds = datas_no_texto(tn)
    if not ds:
        return None, "Teste de Tiro: não encontrei a data do teste."
    return join_parts("Teste de Tiro", tipo_arma_teste(tn), "Val", fmt_dash(mais_um_ano(max(ds)))), None


# Ordem importa: do mais específico para o mais genérico.
RULES = [rule_craf, rule_cac, rule_ctf, rule_simaf, rule_gt, rule_ap, rule_teste_tiro]


def classify_and_name(pdf_path):
    """
    Retorna (novo_nome_sem_extensao, motivo_falha).
    Se novo_nome for None, motivo_falha explica o porquê (ou None se
    simplesmente nenhuma regra bateu).
    """
    try:
        with pdfplumber.open(pdf_path) as pdf:
            full_text, via_ocr = texto_do_pdf(pdf)
            full_text_norm = norm(full_text)
            if len(full_text.strip()) < MIN_TEXTO and not via_ocr and not tesseract_cmd():
                return None, "PDF sem texto (imagem/escaneado): instale o Tesseract para ler por OCR."
            first_error = None
            for rule in RULES:
                result = rule(full_text_norm, full_text, pdf)
                if result is None:
                    continue
                name, err = result
                if name:
                    return name, None
                if first_error is None:
                    first_error = err
                # palavra-chave bateu mas a extração falhou: tenta as
                # próximas regras antes de desistir (evita falso-positivo
                # de uma regra bloquear a regra correta).
            if via_ocr and first_error:
                first_error += " (lido por OCR)"
            return None, first_error
    except Exception as exc:
        return None, f"erro ao ler o PDF: {exc}"


# ---------------------------------------------------------------------------
# Execução principal
# ---------------------------------------------------------------------------

def unique_target(folder, base_name, ext, taken, exclude_path=None):
    """
    Gera um nome de arquivo que não colide com nenhum outro arquivo já
    existente na pasta, nem com nomes já reservados nesta mesma execução.

    'exclude_path' é o próprio arquivo que está sendo renomeado: se o nome
    candidato já existir em disco mas for esse mesmo arquivo (ou seja, ele
    já está com o nome certo), isso NÃO conta como colisão — evita rodar o
    script de novo e acabar sobrescrevendo um arquivo com outro.
    """
    def is_free(name):
        if name in taken:
            return False
        p = folder / name
        if not p.exists():
            return True
        if exclude_path is not None:
            try:
                if p.resolve() == exclude_path.resolve():
                    return True
            except OSError:
                pass
        return False

    candidate = base_name + ext
    if is_free(candidate):
        return candidate
    n = 2
    while True:
        candidate = f"{base_name} ({n}){ext}"
        if is_free(candidate):
            return candidate
        n += 1


def main():
    parser = argparse.ArgumentParser(description="Renomeia PDFs de acordo com o conteúdo.")
    parser.add_argument("--pasta", default=None, help="Caminho da pasta com os PDFs (padrão: pasta deste script).")
    parser.add_argument("--aplicar", action="store_true", help="Aplica as renomeações. Sem essa flag, só simula.")
    args = parser.parse_args()

    folder = Path(args.pasta) if args.pasta else Path(__file__).resolve().parent
    if not folder.is_dir():
        print(f"Pasta não encontrada: {folder}")
        sys.exit(1)

    pdf_files = sorted(p for p in folder.iterdir() if p.suffix.lower() == ".pdf")
    if not pdf_files:
        print(f"Nenhum PDF encontrado em: {folder}")
        return

    modo = "APLICANDO renomeações" if args.aplicar else "SIMULAÇÃO (nada será alterado)"
    print(f"Pasta: {folder}")
    print(f"Modo: {modo}")
    print(f"Arquivos PDF encontrados: {len(pdf_files)}\n")

    planned = []
    unclassified = []
    taken_names = set()

    for pdf_path in pdf_files:
        new_base, err = classify_and_name(pdf_path)
        if new_base:
            new_name = unique_target(folder, new_base, pdf_path.suffix, taken_names, exclude_path=pdf_path)
            taken_names.add(new_name)
            planned.append((pdf_path, new_name))
        else:
            reason = err or "conteúdo não corresponde a nenhuma regra conhecida."
            unclassified.append((pdf_path, reason))

    print("RENOMEAÇÕES PLANEJADAS:")
    if not planned:
        print("  (nenhuma)")
    for old_path, new_name in planned:
        same = old_path.name == new_name
        marker = "= (já está correto)" if same else "->"
        print(f"  {old_path.name}\n    {marker} {new_name}")

    print("\nNÃO CLASSIFICADOS / REVISAR MANUALMENTE:")
    if not unclassified:
        print("  (nenhum)")
    for old_path, reason in unclassified:
        print(f"  {old_path.name}\n    motivo: {reason}")

    if args.aplicar:
        print("\nAplicando renomeações...")
        for old_path, new_name in planned:
            if old_path.name == new_name:
                continue
            target = old_path.with_name(new_name)
            # Trava de segurança final: nunca sobrescrever um arquivo
            # diferente que já exista com esse nome (protege mesmo que o
            # script seja rodado de novo por engano ou em condições
            # inesperadas).
            if target.exists():
                print(f"  AVISO: pulei '{old_path.name}' porque já existe um arquivo "
                      f"diferente chamado '{new_name}'. Renomeie manualmente se necessário.")
                continue
            old_path.rename(target)
            print(f"  Renomeado: {old_path.name} -> {new_name}")
        print("Concluído.")
    else:
        print("\nNenhum arquivo foi alterado (modo simulação).")
        print("Para aplicar de fato, rode novamente com:  --aplicar")


if __name__ == "__main__":
    main()
