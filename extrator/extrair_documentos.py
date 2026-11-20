# -*- coding: utf-8 -*-
"""
Extrai os dados de CRAF, Guia de Tráfego, SIMAF e CTF dos PDFs da pasta
"DOCUMENTOS PORTAL" dos clientes, para importação no CAC Gestão.

O nome sugerido de cada arquivo vem do renomeador (renomeador.py, cópia
sem alterações de RENOMEADOR DE ARQUIVOS/renomear_documentos.py), para que
o padrão de nome seja exatamente o mesmo.

Uso:  python3 extrair_documentos.py arquivo1.pdf [arquivo2.pdf ...]
Saída (stdout): JSON  [{"entrada", "tipo", "campos", "avisos", "nome_sugerido_base", "motivo_nome"}]
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdfplumber  # noqa: E402
import renomeador as R  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DATE = R.DATE_RE
CPF_RE = r"(\d{3}\.\d{3}\.\d{3}-\d{2})"
ESPECIES = ("PISTOLA", "REVOLVER", "REVÓLVER", "ESPINGARDA", "CARABINA", "FUZIL", "RIFLE",
            "GARRUCHA", "PISTOLETE", "SUBMETRALHADORA", "METRALHADORA")


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def iso(data_br):
    """'31/12/2026' -> '2026-12-31' (ou None)."""
    if not data_br:
        return None
    m = re.search(DATE, data_br)
    if not m:
        return None
    d, mth, y = m.group(1).split("/")
    return f"{y}-{mth}-{d}"


def limpa(txt):
    """Junta quebras de linha com espaço e tira espaços sobrando."""
    return re.sub(r"\s+", " ", (txt or "").replace("\n", " ")).strip()


def so_digitos(txt):
    return re.sub(r"\D", "", txt or "")


def busca(padrao, texto, grupo=1, flags=re.IGNORECASE):
    m = re.search(padrao, texto, flags)
    return m.group(grupo).strip() if m else ""


def linha_apos(linhas, condicao, inicio=0):
    """Primeira linha não vazia depois da primeira linha que satisfaz a condição."""
    for i in range(inicio, len(linhas)):
        if condicao(linhas[i]):
            for j in range(i + 1, len(linhas)):
                if linhas[j].strip():
                    return linhas[j].strip(), j
            return "", -1
    return "", -1


def separa_tipo_marca(texto):
    """'PISTOLA FORJAS TAURUS' -> ('PISTOLA', 'FORJAS TAURUS');
    'carabina - FUZIL COMPANHIA' -> ('carabina - FUZIL', 'COMPANHIA')."""
    m = re.match(r"^\s*(carabina\s*[-/]\s*fuzil)\s*(.*)$", texto or "", re.IGNORECASE)
    if m:
        return m.group(1), m.group(2).strip()
    partes = (texto or "").split()
    if partes and R.strip_accents(partes[0]).upper() in [R.strip_accents(e) for e in ESPECIES]:
        return partes[0], " ".join(partes[1:])
    return "", texto


def todas_tabelas(pdf):
    return R.extract_all_tables(pdf)


# ---------------------------------------------------------------------------
# Detecção do tipo (para importação)
# ---------------------------------------------------------------------------

def tipo_documento(tn, texto):
    if "autorizacao de controle de especies exoticas invasoras" in tn:
        return "simaf"
    if "guia de trafego" in tn or re.search(r"\bgte\s*n", tn):
        return "gt"
    # O título precisa estar no começo: outros documentos (ex.: Autorização de
    # Caça) citam o CRAF numa nota no fim do texto.
    inicio = "\n".join(tn.split("\n")[:12])
    if "certificado de registro de arma de fogo" in inicio or "registro federal de arma" in inicio:
        return "craf"
    if "certificado de regularidade" in tn and "cadastros tecnicos federais" in tn:
        return "ctf"
    if "certificado de registro" in tn and "atividades autorizadas" in tn:
        return "cr"
    # CRAF do Exército (SisGCorp) sem rótulos: nº de série + SIGMA numa linha,
    # seguidos de duas datas (validade e expedição), e o link de validação.
    if "sisgcorp" in tn and re.search(r"\n\S+ \d{5,}\n" + DATE + r"\n" + DATE, texto):
        return "craf"
    return None


# ---------------------------------------------------------------------------
# CRAF
# ---------------------------------------------------------------------------

MESES = {"janeiro": "01", "fevereiro": "02", "marco": "03", "abril": "04", "maio": "05", "junho": "06",
         "julho": "07", "agosto": "08", "setembro": "09", "outubro": "10", "novembro": "11", "dezembro": "12"}


def data_por_extenso(texto):
    """'21 de Outubro de 2026' -> '2026-10-21'."""
    m = re.search(r"(\d{1,2}) de ([A-Za-zçÇ]+) de (\d{4})", texto)
    if not m or R.norm(m.group(2)) not in MESES:
        return None
    return f"{m.group(3)}-{MESES[R.norm(m.group(2))]}-{int(m.group(1)):02d}"


def craf_pf(texto):
    """CRAF da Polícia Federal no formato 'Rótulo: valor' (SEI e SINARM antigo)."""
    c = {"modelo_documento": "PF"}
    fim = r"(?=\s{2,}|\s+(?:Modelo|N[ºo°] da Arma|SINARM|MINIST|DEPART|Capacidade|Esp[ée]cie)\b|\n|$)"
    c["numero_craf"] = (busca(r"Registro da Arma de Fogo \(CRAF\)\s*:\s*(\d+)", texto)
                        or busca(r"Registro SINARM-CAC\s*:\s*(\d+)", texto)
                        or busca(r"N[ºo°] do Registro\s*:\s*(\d+)", texto))
    c["validade"] = iso(busca(r"\(CRAF\)\s*:\s*\d+\s*Data de VALIDADE\s*:\s*" + DATE, texto)
                        or busca(r"Arma de Fogo\s*[–-]\s*CRAF\s*:\s*" + DATE, texto)
                        or busca(r"Data de Validade\s*:\s*" + DATE, texto))
    c["numero_cr"] = (busca(r"Certificado de Registro \(CR\)\s*:\s*([\d.\-/]+)", texto)
                      or busca(r"Certificado de Registro\s*:\s*([\d.\-/]+)", texto))
    c["nome"] = busca(r"Propriet[áa]rio\s*:\s*([^\n]+)", texto) or busca(r"\bNome\s*:\s*([^\n]+)", texto)
    c["cpf"] = busca(r"CPF\s*:\s*" + CPF_RE, texto)
    c["numero_serie"] = (busca(r"N[úu]mero de S[ée]rie\s*:\s*(\S+)", texto)
                         or busca(r"N[úu]mero da Arma\s*:\s*(\S+)", texto)
                         or busca(r"N[ºo°] da Arma\s*:\s*(\S+)", texto))
    c["numero_sigma"] = busca(r"N[ºo°]\s*SIGMA\s*:\s*(\S+)", texto)
    c["marca"] = busca(r"Marca\s*:\s*(.+?)" + fim, texto)
    c["modelo"] = busca(r"Modelo\s*:\s*(.+?)" + fim, texto)
    c["calibre"] = busca(r"Calibre\s*:\s*(.+?)" + fim, texto)
    c["especie"] = busca(r"Esp[ée]cie\s*:\s*([^\s\d:]+)", texto)
    c["data_expedicao"] = (iso(busca(r"assinad[oa] eletronicamente por .*?, em " + DATE, texto, flags=re.IGNORECASE | re.DOTALL))
                           or data_por_extenso(texto))
    return c


def par_por_posicao(pdf, rot_esq, rot_dir):
    """Layout 'rótulo em cima, valor embaixo' com dois rótulos na mesma linha
    (ex.: 'CALIBRE   MARCA'). Devolve (valor_esquerdo, valor_direito) da linha
    logo abaixo, separando pela posição x do rótulo da direita."""
    for page in pdf.pages:
        words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
        n = lambda w: R.norm(w["text"]).strip(" .:")  # noqa: E731
        for we in (w for w in words if n(w) == rot_esq):
            wd = next((w for w in words if n(w) == rot_dir and abs(w["top"] - we["top"]) <= 6 and w["x0"] > we["x0"]), None)
            if not wd:
                continue
            base = max(we["bottom"], wd["bottom"])
            abaixo = [w for w in words if w["top"] > base - 1]
            if not abaixo:
                continue
            topo = min(w["top"] for w in abaixo)
            linha = sorted((w for w in abaixo if w["top"] - topo <= 4), key=lambda w: w["x0"])
            corte = wd["x0"] - 6  # o valor pode começar um pouco antes do rótulo
            esq = " ".join(w["text"] for w in linha if w["x0"] < corte)
            dire = " ".join(w["text"] for w in linha if w["x0"] >= corte)
            return esq.strip(), dire.strip()
    return "", ""


def craf_rotulado(texto, pdf):
    """CRAF com rótulos em cima e valores embaixo (Exército e o 'Visualizar
    Documento (CRAF)' da PF): VALIDADE / NOME COMPLETO / CPF ... / TIPO MARCA ..."""
    linhas = texto.split("\n")
    up = lambda s: R.norm(s).strip()  # noqa: E731
    c = {"modelo_documento": "PF" if "policia federal" in R.norm(texto) else "EB"}
    c["validade"] = iso(linha_apos(linhas, lambda l: up(l) == "validade")[0])
    c["nome"] = linha_apos(linhas, lambda l: up(l).startswith("nome completo"))[0]
    doc_linha = linha_apos(linhas, lambda l: up(l).startswith("cpf"))[0]
    cpf = re.search(CPF_RE, doc_linha) or re.search(r"\b(\d{11})\b", doc_linha)
    c["cpf"] = cpf.group(1) if cpf else ""
    especie, marca = par_por_posicao(pdf, "tipo", "marca")
    if not especie and not marca:
        c["numero_craf"], especie = par_por_posicao(pdf, "registro", "tipo")
        c["calibre"], marca = par_por_posicao(pdf, "calibre", "marca")
    if especie and not marca:
        # valor numa linha só, sem alinhar com o rótulo MARCA (ex.: 'ESPINGARDA ARMSAN')
        esp2, marca2 = separa_tipo_marca(especie)
        if esp2:
            especie, marca = esp2, marca2
    c["especie"], c["marca"] = especie, marca
    if not c.get("calibre"):
        c["calibre"] = linha_apos(linhas, lambda l: up(l) == "calibre")[0]
    serie, sigma = par_por_posicao(pdf, "serie", "sigma")
    if serie and not sigma and len(serie.split()) == 2:
        serie, sigma = serie.split()  # valores numa linha só, sem alinhar com os rótulos
    if serie:
        c["numero_serie"], c["numero_sigma"] = serie, sigma
        c["data_expedicao"] = iso(linha_apos(linhas, lambda l: up(l).startswith("data de expedicao"))[0])
    else:
        serie, exped = par_por_posicao(pdf, "serie", "data")
        c["numero_serie"], c["numero_sigma"], c["data_expedicao"] = serie, "", iso(exped)
    c["modelo"] = ""
    return c


def craf_exercito_sem_rotulo(texto):
    """CRAF do Exército (SisGCorp) só com os valores, em ordem fixa:
    TIPO MARCA / NOME / CALIBRE / CPF CR RM / SÉRIE SIGMA / VALIDADE / EXPEDIÇÃO."""
    linhas = [l.strip() for l in texto.split("\n") if l.strip()]
    c = {"modelo_documento": "EB"}
    idx = next((i for i, l in enumerate(linhas)
                if re.fullmatch(r"\S+ \d{5,}", l)
                and i + 2 < len(linhas)
                and re.fullmatch(DATE, linhas[i + 1]) and re.fullmatch(DATE, linhas[i + 2])), None)
    if idx is None or idx < 4:
        return c
    serie, sigma = linhas[idx].split()
    c["numero_serie"], c["numero_sigma"] = serie, sigma
    c["validade"] = iso(linhas[idx + 1])
    c["data_expedicao"] = iso(linhas[idx + 2])
    doc_linha = linhas[idx - 1]
    cpfs = re.findall(CPF_RE, doc_linha)
    c["cpf"] = cpfs[0] if cpfs else ""
    c["numero_cr"] = cpfs[1] if len(cpfs) > 1 else busca(r"\d{3}\.\d{3}\.\d{3}-\d{2}\s+([\d.\-]+)", doc_linha)
    c["calibre"] = linhas[idx - 2]
    c["nome"] = linhas[idx - 3]
    c["especie"], c["marca"] = separa_tipo_marca(linhas[idx - 4])
    c["modelo"] = ""
    return c


def extrair_craf(texto, tn, pdf):
    if re.search(r"esp[ée]cie\s*:", texto, re.IGNORECASE):
        c = craf_pf(texto)
    elif "nome completo" in tn:
        c = craf_rotulado(texto, pdf)
    else:
        c = craf_exercito_sem_rotulo(texto)
    avisos = []
    if not c.get("numero_serie"):
        avisos.append("CRAF: não encontrei o nº de série.")
    if not c.get("validade"):
        avisos.append("CRAF: não encontrei a validade.")
    return c, avisos


# ---------------------------------------------------------------------------
# Guia de Tráfego
# ---------------------------------------------------------------------------

def produtos_gt(tabelas):
    """Todas as linhas de produto (armas) da tabela '5. PRODUTOS CONTROLADOS'."""
    produtos = []
    for tabela in tabelas:
        for r, row in enumerate(tabela):
            if not row:
                continue
            n = [R.norm(c or "") for c in row]
            col = {}
            for chave, kw in (("especie", "especie"), ("marca", "marca"), ("modelo", "modelo"),
                              ("calibre", "calibre"), ("serie", "serie"), ("quantidade", "quantidade")):
                for i, cel in enumerate(n):
                    if kw in cel:
                        col[chave] = i
                        break
            if not {"especie", "serie"} <= col.keys():
                continue
            cab = {k: (row[i] or "") for k, i in col.items()}
            for dados in tabela[r + 1:]:
                if not dados or not any((x or "").strip() for x in dados):
                    continue
                primeira = limpa(next((x for x in dados if x), ""))
                if primeira.startswith("*") or re.match(r"^\d+\.\s", primeira):
                    break
                res = {k: {"header": cab[k], "value": (dados[i] if i < len(dados) else "") or ""}
                       for k, i in col.items()}
                especie = limpa(R.compound_cell_value(res, "especie", "especie"))
                modelo = limpa(R.compound_cell_value(res, "modelo", "modelo")) if "modelo" in res else ""
                serie = limpa(res["serie"]["value"])
                if not especie or "munic" in R.norm(especie) or not serie or set(serie) <= {"*"}:
                    continue
                produtos.append({
                    "especie": especie,
                    "marca": limpa(res["marca"]["value"]).rstrip(",") if "marca" in res else "",
                    "modelo": modelo,
                    "calibre": limpa(res["calibre"]["value"]) if "calibre" in res else "",
                    "numero_serie": serie,
                    "quantidade": limpa(res["quantidade"]["value"]) if "quantidade" in res else "",
                })
            break
    # remove repetidos (mesma série em páginas diferentes)
    vistos, unicos = set(), []
    for p in produtos:
        if p["numero_serie"] not in vistos:
            vistos.add(p["numero_serie"])
            unicos.append(p)
    return unicos


def bloco(texto, ini, fim):
    m = re.search(ini + r"(.*?)" + fim, texto, re.IGNORECASE | re.DOTALL)
    return m.group(1) if m else ""


def extrair_gt(texto, tn, pdf):
    c = {}
    sei = "6. validade" in tn or not re.search(r"\bgte\s*n", tn)  # modelo PF/SEI, sem nº de GTE
    c["modelo_documento"] = "PF-SEI" if sei else "GTE"
    c["numero_gt"] = busca(r"GTE\s*N[ºo°]\s*:?\s*(\d+)", texto)
    c["numero_sei"] = busca(r"SEI n[ºo°]\s*(\d+)", texto) or busca(r"C[óo]digo verificador\s*:\s*(\d+)", texto)
    if sei and not c["numero_gt"]:
        c["numero_gt"] = c["numero_sei"]  # guia PF/SEI não tem nº de GTE: usa o nº SEI
    c["data_emissao"] = iso(busca(r"RM\s*:.*?\bde\s+" + DATE, texto))
    m = re.search(r"Validade\s*:?\s*" + DATE + r"\s*(?:à|a|-|ate|até)\s*" + DATE, texto, re.IGNORECASE)
    c["validade_inicio"] = iso(m.group(1)) if m else None
    c["validade"] = iso(m.group(2)) if m else iso(busca(r"\d\.\s*VALIDADE\s*" + DATE, texto))
    if not c["data_emissao"]:
        c["data_emissao"] = (c["validade_inicio"]
                             or iso(busca(r"assinado eletronicamente por .*?, em " + DATE, texto, flags=re.IGNORECASE | re.DOTALL)))
    c["numero_cr"] = busca(r"\bCR\s*:\s*([\d.\-]+)", texto)
    c["cpf"] = busca(r"\bCPF\s*:\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})", texto)
    c["nome"] = busca(r"\bNome\s*:\s*(.+?)(?:\s+Telefone\s*:|\n)", texto)

    m_fin = re.search(r"4\.\s*FINALIDADE[ \t]*([^\n]*)\n?([^\n]*)", texto, re.IGNORECASE)
    fin_raw = (m_fin.group(1).strip() or m_fin.group(2).strip()) if m_fin else ""
    finalidade = R.normalize_finalidade(fin_raw) if fin_raw else ""
    c["finalidade"] = finalidade

    origem = bloco(texto, r"2\.\s*LOCAL DE ORIGEM", r"3\.\s*LOCAL DE DESTINO")
    c["origem_endereco"] = busca(r"Endere[cç]o e CEP\s*:?\s*([^\n]+)", origem) or limpa(origem)

    destino = bloco(texto, r"3\.\s*LOCAL DE DESTINO", r"4\.\s*FINALIDADE")
    nome_dest = R.strip_leading_code(busca(r"Nome\s*/\s*Raz[aã]o Social\s*:?\s*([^\n]+)", destino))
    end_dest = busca(r"Endere[cç]o e CEP\s*:?\s*([^\n]+)", destino)
    pcu = busca(r"P[aá][ií]s\s*/\s*Cidade\s*/\s*UF\s*/\s*Aeroporto-?Porto\s*:?\s*([^\n]+)", destino)
    partes = [p.strip() for p in pcu.split("/")] if pcu else []
    vazio = lambda v: (not v) or set(v.upper()) <= {"X"}  # noqa: E731
    c["destino_nome"] = "" if vazio(nome_dest) else nome_dest
    c["destino_endereco"] = "" if vazio(end_dest.replace(",", "").replace(" ", "")) else end_dest
    c["destino_cidade"] = partes[1] if len(partes) > 1 and not vazio(partes[1]) else ""
    c["destino_uf"] = partes[2] if len(partes) > 2 and not vazio(partes[2]) else ""
    if sei and not (nome_dest or end_dest or pcu):
        # modelo SEI: o destino vem solto, ex.: "Bom Jesus / RS"
        m_cid = re.search(r"([^\n/]+?)\s*/\s*([A-Za-z]{2})\s*$", destino.strip())
        if m_cid:
            c["destino_cidade"], c["destino_uf"] = m_cid.group(1).strip(), m_cid.group(2).upper()
        elif limpa(destino):
            c["destino_nome"] = limpa(destino)
    c["destino"] = R.extract_destino(texto, finalidade)

    c["produtos"] = produtos_gt(todas_tabelas(pdf))
    avisos = []
    if not c["numero_gt"] and not sei:
        avisos.append("GT: não encontrei o nº da GTE.")
    if not c["validade"]:
        avisos.append("GT: não encontrei a validade.")
    if not c["produtos"]:
        avisos.append("GT: não encontrei armas na tabela de produtos.")
    if not finalidade:
        avisos.append("GT: não encontrei a finalidade.")
    return c, avisos


# ---------------------------------------------------------------------------
# SIMAF
# ---------------------------------------------------------------------------

def extrair_simaf(texto, tn, pdf):
    c = {}
    c["numero"] = busca(r"N[úu]mero\s*:\s*(\S+)", texto)
    c["situacao"] = busca(r"Situa[çc][ãa]o\s*:\s*([^\n]+)", texto)
    c["solicitante"] = busca(r"Solicitante\s*:\s*([^\n]+)", texto)
    c["ctf"] = busca(r"\bCTF\s*:\s*(\d+)", texto)
    c["especie"] = busca(r"Esp[ée]cie\s*:\s*([^\n]+)", texto)
    c["data_autorizacao"] = iso(busca(r"Data da autoriza[çc][ãa]o\s*:\s*" + DATE, texto))
    c["inicio"] = iso(busca(r"Per[ií]odo In[ií]cio\s*:\s*" + DATE, texto))
    c["validade"] = iso(busca(r"Fim\s*:?\s*" + DATE, texto))

    propriedades, cpfs = [], []
    for tabela in todas_tabelas(pdf):
        for r, row in enumerate(tabela):
            n = [R.norm(x or "") for x in (row or [])]
            if any("propriedade" in x for x in n) and any(x.strip() == "car" for x in n):
                col = {k: next((i for i, x in enumerate(n) if kw(x)), None) for k, kw in (
                    ("propriedade", lambda x: "propriedade" == x.strip()),
                    ("car", lambda x: x.strip() == "car"),
                    ("matricula", lambda x: "matricula" in x),
                    ("proprietario", lambda x: "proprietario" in x),
                    ("endereco", lambda x: "endereco" in x),
                    ("cidade", lambda x: "cidade" in x),
                )}
                for dados in tabela[r + 1:]:
                    if not dados or not any((x or "").strip() for x in dados):
                        continue
                    pega = lambda k: (dados[col[k]] or "") if col.get(k) is not None and col[k] < len(dados) else ""  # noqa: E731
                    cidade_uf = limpa(pega("cidade"))
                    cidade, uf = (cidade_uf.rsplit("/", 1) + [""])[:2] if "/" in cidade_uf else (cidade_uf, "")
                    propriedades.append({
                        "propriedade": limpa(pega("propriedade")),
                        "car": re.sub(r"\s+", "", pega("car")),
                        "matricula": limpa(pega("matricula")),
                        "proprietario": limpa(pega("proprietario")),
                        "endereco": limpa(pega("endereco")),
                        "cidade": cidade.strip(),
                        "uf": uf.strip(),
                    })
            if [x.strip() for x in n[:3]] == ["ctf", "cpf", "nome"]:
                for dados in tabela[r + 1:]:
                    if dados and len(dados) > 1 and so_digitos(dados[1] or ""):
                        cpfs.append(so_digitos(dados[1]))
    c["propriedades"] = propriedades
    c["cpfs_participantes"] = cpfs
    avisos = []
    if not c["validade"]:
        avisos.append("SIMAF: não encontrei a data fim.")
    if not propriedades:
        avisos.append("SIMAF: não encontrei a propriedade.")
    return c, avisos


# ---------------------------------------------------------------------------
# CTF / IBAMA (Certificado de Regularidade)
# ---------------------------------------------------------------------------

def extrair_ctf(texto, tn, pdf):
    """Validade ("CR válido até"), emissão e nº do registro. A validade usa a
    mesma leitura do renomeador (tabela; senão, a linha com as 3 datas)."""
    c = {"registro": "", "emissao": None, "validade": None, "cpf": "", "nome": ""}
    tabelas = todas_tabelas(pdf)
    res = R.table_lookup(tabelas, {"registro": "registro", "emitido": "cr emitido em", "valido_ate": "cr valido ate"})
    if res:
        c["registro"] = so_digitos(R.cell_value(res, "registro"))
        c["emissao"] = iso(R.cell_value(res, "emitido"))
        c["validade"] = iso(R.cell_value(res, "valido_ate"))
    if not c["validade"]:
        m = re.search(r"(\d{5,})\s+" + DATE + r"\s+" + DATE + r"\s+" + DATE, texto)
        if m:
            c["registro"], c["emissao"], c["validade"] = m.group(1), iso(m.group(3)), iso(m.group(4))
    c["cpf"] = busca(r"CPF\s*:\s*" + CPF_RE, texto)
    c["nome"] = busca(r"Nome\s*:\s*([^\n]+)", texto)
    avisos = [] if c["validade"] else ["CTF: não encontrei a data 'CR válido até'."]
    return c, avisos


# ---------------------------------------------------------------------------
# Principal
# ---------------------------------------------------------------------------

EXTRATORES = {"craf": extrair_craf, "gt": extrair_gt, "simaf": extrair_simaf, "ctf": extrair_ctf}


def processar(caminho):
    saida = {"entrada": caminho, "tipo": None, "campos": {}, "avisos": [],
             "nome_sugerido_base": None, "motivo_nome": None}
    try:
        nome_base, motivo = R.classify_and_name(caminho)
        saida["nome_sugerido_base"], saida["motivo_nome"] = nome_base, motivo
        with pdfplumber.open(caminho) as pdf:
            texto = R.extract_full_text(pdf)
            tn = R.norm(texto)
            if len(texto.strip()) < 200:
                saida["avisos"].append("PDF sem texto (provavelmente imagem ou foto): não dá para ler os dados.")
            tipo = tipo_documento(tn, texto)
            saida["tipo"] = tipo
            if tipo in EXTRATORES:
                campos, avisos = EXTRATORES[tipo](texto, tn, pdf)
                saida["campos"], saida["avisos"] = campos, avisos
    except Exception as exc:  # um PDF ruim não derruba os outros
        saida["avisos"].append(f"erro ao ler o PDF: {exc}")
    return saida


def main():
    print(json.dumps([processar(p) for p in sys.argv[1:]], ensure_ascii=False))


if __name__ == "__main__":
    main()
